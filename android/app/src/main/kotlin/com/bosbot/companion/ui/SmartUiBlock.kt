package com.openmausbot.companion.ui

import android.annotation.SuppressLint
import android.content.Intent
import android.graphics.Color as AndroidColor
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import kotlinx.serialization.json.JsonObject

/**
 * A reply's ```chart, ```stats and ```openui blocks, drawn full width by the
 * same components the desktop chat uses — the port of `SmartUIBlock.swift`.
 *
 * The components are web: rather than a second copy in Compose that drifts from
 * the desktop, each block is a transparent WebView over the bundled
 * `assets/smart-ui.html`, sized to its content. The page has no network; the
 * bridge carries its height, saved values, button presses and links back here.
 * A block it can't draw comes back as [fallback], the plain code card.
 */
@Composable
internal fun SmartUiBlock(
    language: String,
    code: String,
    streaming: Boolean,
    messageId: String?,
    savedStates: Map<String, JsonObject>?,
    openLink: ((String) -> Unit)?,
    fallback: @Composable () -> Unit,
) {
    var failed by remember { mutableStateOf(false) }
    if (failed) {
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            fallback()
            if (SmartUi.isOpenUi(language)) {
                Text(
                    text = "couldn't draw this",
                    fontSize = 12.sp,
                    color = secondaryTint,
                )
            }
        }
    } else {
        SmartUiWebBlock(
            language = language,
            code = code,
            streaming = streaming,
            messageId = messageId,
            savedStates = savedStates,
            openLink = openLink,
            onFailed = { failed = true },
        )
    }
}

@Composable
private fun SmartUiWebBlock(
    language: String,
    code: String,
    streaming: Boolean,
    messageId: String?,
    savedStates: Map<String, JsonObject>?,
    openLink: ((String) -> Unit)?,
    onFailed: () -> Unit,
) {
    val context = LocalContext.current
    val dark = MaterialTheme.colorScheme.background.luminance() < 0.5f
    val cacheKey = SmartUi.cacheKey(language, code, dark)
    var measured by remember(cacheKey) { mutableStateOf<Float?>(null) }
    // A killed page process leaves a dead view; a new generation builds a new one.
    var generation by remember { mutableIntStateOf(0) }

    val payload = SmartUi.payload(
        language = language,
        code = code,
        streaming = streaming,
        dark = dark,
        states = SmartUi.states(messageId, savedStates),
    ).toString()

    val streamingNow by rememberUpdatedState(streaming)
    val cacheKeyNow by rememberUpdatedState(cacheKey)
    val threadNow by rememberUpdatedState(LocalSmartUiThread.current)
    val messageIdNow by rememberUpdatedState(messageId)
    val openLinkNow by rememberUpdatedState(openLink)
    val onFailedNow by rememberUpdatedState(onFailed)
    val bridge = remember(generation) {
        SmartUiBridge { event ->
            when (event) {
                is SmartUiEvent.Height -> {
                    val next = event.value.toFloat()
                    if (measured != next) measured = next
                    if (!streamingNow) SmartUi.heights[cacheKeyNow] = next
                }
                SmartUiEvent.Failed -> if (!streamingNow) onFailedNow()
                is SmartUiEvent.Assistant -> threadNow?.send?.invoke(event.text)
                is SmartUiEvent.OpenUrl -> {
                    val open = openLinkNow
                    if (open != null) open(event.url) else openExternally(context, event.url)
                }
                is SmartUiEvent.State -> {
                    val id = messageIdNow
                    val hooks = threadNow
                    if (id != null && hooks != null) {
                        SmartUi.live.getOrPut(id) { java.util.concurrent.ConcurrentHashMap() }[event.key] = event.state
                        hooks.save(id, event.key, event.state)
                    }
                }
                SmartUiEvent.Ready -> Unit
            }
        }.also { it.onProcessGone = { generation += 1 } }
    }

    key(generation) {
        AndroidView(
            modifier = Modifier
                .fillMaxWidth()
                .height((measured ?: SmartUi.heights[cacheKey] ?: SmartUi.DEFAULT_HEIGHT).dp),
            factory = { ctx -> bridge.attach(newSmartUiWebView(ctx, bridge)) },
            update = { bridge.render(payload) },
            onRelease = { bridge.detach(it) },
        )
    }
}

private fun openExternally(context: android.content.Context, url: String) {
    if (!SmartUi.isWebUrl(url)) return
    runCatching {
        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
}

/** A page that never scrolls itself vertically: the transcript does that. */
private class SmartUiWebView(context: android.content.Context) : WebView(context) {
    override fun scrollTo(x: Int, y: Int) = super.scrollTo(x, 0)
}

@SuppressLint("SetJavaScriptEnabled")
private fun newSmartUiWebView(context: android.content.Context, bridge: SmartUiBridge): WebView =
    SmartUiWebView(context).apply {
        setBackgroundColor(AndroidColor.TRANSPARENT)
        isVerticalScrollBarEnabled = false
        isHorizontalScrollBarEnabled = false
        overScrollMode = View.OVER_SCROLL_NEVER
        settings.apply {
            javaScriptEnabled = true
            allowFileAccess = true
            allowContentAccess = false
            blockNetworkLoads = true
            domStorageEnabled = false
            setSupportZoom(false)
            builtInZoomControls = false
        }
        webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url.toString()
                if (url == SmartUi.PAGE_URL) return false
                if (SmartUi.isWebUrl(url)) bridge.deliver(SmartUiEvent.OpenUrl(url))
                return true
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                bridge.processGone()
                return true
            }
        }
        addJavascriptInterface(bridge, "BosSmartUI")
        loadUrl(SmartUi.PAGE_URL)
    }

/**
 * The seam between one block's WebView and its composable: the page posts here
 * (on a JavaScript thread, hopped to main), and renders go out once the page
 * says it is ready, skipping a payload identical to the last one sent.
 */
internal class SmartUiBridge(private val onEvent: (SmartUiEvent) -> Unit) {
    var onProcessGone: () -> Unit = {}
    private val main = Handler(Looper.getMainLooper())
    private var webView: WebView? = null
    private var ready = false
    private var pending: String? = null
    private var sent: String? = null

    fun attach(view: WebView): WebView {
        webView = view
        return view
    }

    fun detach(view: WebView) {
        webView = null
        ready = false
        view.removeJavascriptInterface("BosSmartUI")
        view.destroy()
    }

    fun processGone() = main.post { onProcessGone() }

    fun render(json: String) {
        pending = json
        val view = webView ?: return
        if (!ready || json == sent) return
        sent = json
        view.evaluateJavascript("window.bosSmartUI.render($json)", null)
    }

    fun deliver(event: SmartUiEvent) {
        main.post { handle(event) }
    }

    @JavascriptInterface
    fun post(json: String) {
        val event = SmartUi.parseEvent(json) ?: return
        main.post { handle(event) }
    }

    private fun handle(event: SmartUiEvent) {
        if (event == SmartUiEvent.Ready) {
            ready = true
            sent = null
            pending?.let(::render)
            return
        }
        onEvent(event)
    }
}
