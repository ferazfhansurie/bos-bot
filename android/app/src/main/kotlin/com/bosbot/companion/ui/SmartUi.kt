package com.openmausbot.companion.ui

import androidx.compose.runtime.staticCompositionLocalOf
import java.util.concurrent.ConcurrentHashMap
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.put

/**
 * The live transcript's hooks for smart ui blocks: post as the person into this
 * thread, and save a block's values onto its message. Set once on the
 * transcript; null in previews and shared views, where blocks still draw and
 * their buttons stay quiet.
 */
class SmartUiThread(
    val send: (String) -> Unit,
    val save: (messageId: String, key: String, state: JsonObject) -> Unit,
)

val LocalSmartUiThread = staticCompositionLocalOf<SmartUiThread?> { null }

/** What the bundled page posts back through `BosSmartUI.post`. */
sealed interface SmartUiEvent {
    data object Ready : SmartUiEvent
    data class Height(val value: Double) : SmartUiEvent
    data object Failed : SmartUiEvent
    data class Assistant(val text: String) : SmartUiEvent
    data class OpenUrl(val url: String) : SmartUiEvent
    data class State(val key: String, val state: JsonObject) : SmartUiEvent
}

/**
 * The pure half of the inline chart / stats / openui blocks — the port of
 * `SmartUI` in `ios/App/SmartUIBlock.swift`. The WebView half is `SmartUiBlock`.
 */
object SmartUi {
    const val PAGE_URL = "file:///android_asset/smart-ui.html"

    private val languages = setOf("chart", "stats", "openui", "openui-lang")

    fun handles(language: String?): Boolean =
        language != null && language.lowercase() in languages

    /** openui blocks get a caption when they fall back; chart and stats do not. */
    fun isOpenUi(language: String): Boolean = language.lowercase().startsWith("openui")

    /** Heights already measured, so a block scrolled back on screen opens at its size. */
    val heights = ConcurrentHashMap<String, Float>()

    /** Values typed this session, ahead of the server echoing them back. */
    val live = ConcurrentHashMap<String, ConcurrentHashMap<String, JsonObject>>()

    const val DEFAULT_HEIGHT = 120f

    fun cacheKey(language: String, code: String, dark: Boolean): String =
        "${if (dark) "d" else "l"}|${language.lowercase()}|${code.length}|${code.hashCode()}"

    /** The message's saved values with this session's typing laid over them. */
    fun states(
        messageId: String?,
        saved: Map<String, JsonObject>?,
        live: Map<String, Map<String, JsonObject>> = SmartUi.live,
    ): Map<String, JsonObject> {
        val merged = LinkedHashMap<String, JsonObject>()
        saved?.let(merged::putAll)
        if (messageId != null) live[messageId]?.let(merged::putAll)
        return merged
    }

    fun payload(
        language: String,
        code: String,
        streaming: Boolean,
        dark: Boolean,
        states: Map<String, JsonObject>,
    ): JsonObject = buildJsonObject {
        put("lang", language)
        put("code", code)
        put("streaming", streaming)
        put("theme", if (dark) "dark" else "light")
        put("states", JsonObject(states))
    }

    fun parseEvent(raw: String): SmartUiEvent? {
        val obj = runCatching { Json.parseToJsonElement(raw) as? JsonObject }.getOrNull() ?: return null
        fun string(name: String): String? = (obj[name] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
        return when (string("type")) {
            "ready" -> SmartUiEvent.Ready
            "failed" -> SmartUiEvent.Failed
            "height" -> (obj["value"] as? JsonPrimitive)?.doubleOrNull
                ?.takeIf { it.isFinite() && it > 0 }
                ?.let(SmartUiEvent::Height)
            "assistant" -> string("text")?.takeIf { it.isNotEmpty() }?.let(SmartUiEvent::Assistant)
            "openUrl" -> string("url")?.takeIf(::isWebUrl)?.let(SmartUiEvent::OpenUrl)
            "state" -> {
                val key = string("key") ?: return null
                val state = obj["state"] as? JsonObject ?: return null
                SmartUiEvent.State(key, state)
            }
            else -> null
        }
    }

    fun isWebUrl(url: String): Boolean {
        val lower = url.trim().lowercase()
        return lower.startsWith("http://") || lower.startsWith("https://")
    }
}
