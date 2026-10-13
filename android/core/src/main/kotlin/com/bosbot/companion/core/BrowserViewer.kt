package com.openmausbot.companion.core

import java.net.URLEncoder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.buffer
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import okhttp3.Request

@Serializable data class BrowserViewerTab(val tabId: String, val title: String, val url: String, val active: Boolean)
@Serializable data class BrowserFrameMetadata(val deviceWidth: Int, val deviceHeight: Int)
@Serializable data class BrowserViewerPayload(
    val viewerId: String? = null, val seq: Int? = null, val data: String? = null,
    val metadata: BrowserFrameMetadata? = null, val tabs: List<BrowserViewerTab>? = null,
    val url: String? = null, val connected: Boolean? = null, val held: Boolean? = null,
    val controlling: Boolean? = null, val owned: Boolean? = null, val message: String? = null,
    val retryable: Boolean? = null,
)
data class BrowserViewerEvent(val name: String, val payload: BrowserViewerPayload) {
    companion object {
        fun decode(name: String, data: String): BrowserViewerEvent {
            require(name in setOf("ready", "frame", "tabs", "url", "status", "control", "heartbeat", "error")) { "Invalid browser update." }
            require(data.toByteArray().size <= BROWSER_EVENT_LIMIT) { "Browser update exceeded its size limit." }
            val payload = CompanionJson.decodeFromString<BrowserViewerPayload>(data)
            if (name == "frame") {
                val size = requireNotNull(payload.metadata)
                require((payload.seq ?: 0) > 0 && payload.data != null && payload.data.length <= 3 * 1024 * 1024 &&
                    size.deviceWidth in 1..8192 && size.deviceHeight in 1..8192 &&
                    size.deviceWidth.toLong() * size.deviceHeight <= 16_777_216) { "Invalid browser frame." }
            }
            return BrowserViewerEvent(name, payload)
        }
    }
}
private const val BROWSER_EVENT_LIMIT = 4 * 1024 * 1024

/** Browser event names are protocol fields, unlike the chat stream. Bound incomplete events too. */
class BrowserSSEParser {
    private var name = ""
    private val data = mutableListOf<String>()
    private var bytes = 0
    fun line(raw: String): BrowserViewerEvent? {
        val line = raw.removeSuffix("\r")
        bytes += raw.toByteArray().size + 1
        require(bytes <= BROWSER_EVENT_LIMIT) { "Browser update exceeded its size limit." }
        if (line.isEmpty()) {
            val eventName = name
            val eventData = data.joinToString("\n")
            reset()
            return if (eventData.isEmpty()) null else BrowserViewerEvent.decode(eventName, eventData)
        }
        if (line.startsWith(':')) return null
        val colon = line.indexOf(':')
        val field = if (colon < 0) line else line.take(colon)
        val value = if (colon < 0) "" else line.substring(colon + 1).removePrefix(" ")
        when (field) { "event" -> name = value; "data" -> data += value }
        return null
    }
    fun reset() { name = ""; data.clear(); bytes = 0 }
}

/** Closing collection cancels the dedicated request and drops its server-owned control lease. */
fun browserViewerStream(request: Request, client: OkHttpClient): Flow<BrowserViewerEvent> = callbackFlow {
    val call = client.newCall(request)
    val reader = launch(Dispatchers.IO) {
        try {
            call.execute().use { response ->
                if (response.code != 200) throw APIError.Status(response.code)
                val source = response.body?.source() ?: throw APIError.Transport("The browser sent an empty stream.")
                val parser = BrowserSSEParser()
                while (isActive && !source.exhausted()) {
                    val line = source.readUtf8LineStrict(BROWSER_EVENT_LIMIT.toLong())
                    parser.line(line)?.let { send(it) }
                }
                if (isActive) throw APIError.Transport("The browser connection ended.")
            }
        } catch (error: Exception) { if (isActive) close(error) }
    }
    awaitClose { call.cancel(); reader.cancel() }
}.buffer(0)

sealed class BrowserViewerAction {
    data object Take : BrowserViewerAction(); data object Release : BrowserViewerAction()
    data object Back : BrowserViewerAction(); data object Forward : BrowserViewerAction()
    data object Reload : BrowserViewerAction(); data object Restart : BrowserViewerAction()
    data object NewTab : BrowserViewerAction(); data object Enter : BrowserViewerAction()
    data class Acknowledge(val seq: Int) : BrowserViewerAction()
    data class SelectTab(val id: String) : BrowserViewerAction()
    data class CloseTab(val id: String) : BrowserViewerAction()
    data class Navigate(val url: String) : BrowserViewerAction()
    data class Text(val text: String) : BrowserViewerAction()
    data class Tap(val seq: Int, val x: Double, val y: Double) : BrowserViewerAction()
    data class Scroll(val seq: Int, val x: Double, val y: Double, val deltaX: Double, val deltaY: Double) : BrowserViewerAction()
    fun body(): JsonObject = buildJsonObject {
        when (val action = this@BrowserViewerAction) {
            Take -> put("type", "take"); Release -> put("type", "release")
            Back -> put("type", "back"); Forward -> put("type", "forward")
            Reload -> put("type", "reload"); Restart -> put("type", "restart")
            NewTab -> put("type", "tab-new")
            Enter -> { put("type", "input_keyboard"); put("eventType", "keyDown"); put("key", "Enter") }
            is Acknowledge -> { put("type", "ack"); put("seq", action.seq) }
            is SelectTab -> { put("type", "tab-select"); put("tabId", action.id) }
            is CloseTab -> { put("type", "tab-close"); put("tabId", action.id) }
            is Navigate -> { put("type", "navigate"); put("url", action.url) }
            is Text -> { put("type", "input_keyboard"); put("eventType", "char"); put("text", action.text) }
            is Tap -> { put("type", "tap"); put("seq", action.seq); put("x", action.x); put("y", action.y) }
            is Scroll -> { put("type", "input_mouse"); put("eventType", "mouseWheel"); put("frameSeq", action.seq); put("x", action.x); put("y", action.y); put("deltaX", action.deltaX); put("deltaY", action.deltaY) }
        }
    }
}

/** Letterbox hits outside the rendered page must never become browser clicks. */
fun browserPagePoint(x: Float, y: Float, viewWidth: Int, viewHeight: Int, pageWidth: Int, pageHeight: Int): Pair<Double, Double>? {
    if (viewWidth <= 0 || viewHeight <= 0 || pageWidth <= 0 || pageHeight <= 0) return null
    val scale = minOf(viewWidth.toDouble() / pageWidth, viewHeight.toDouble() / pageHeight)
    val px = (x - (viewWidth - pageWidth * scale) / 2) / scale
    val py = (y - (viewHeight - pageHeight * scale) / 2) / scale
    return if (px.isFinite() && py.isFinite() && px >= 0 && py >= 0 && px < pageWidth && py < pageHeight) px to py else null
}
fun browserNavigationURL(value: String): String {
    val text = value.trim()
    val uri = runCatching { java.net.URI(text) }.getOrNull()
    if (uri?.scheme in setOf("http", "https")) return text
    if (' ' !in text && '.' in text && ':' !in text) return "https://$text"
    return "https://www.google.com/search?q=${URLEncoder.encode(text, "UTF-8")}" 
}
