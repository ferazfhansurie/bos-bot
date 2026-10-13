package com.openmausbot.companion.ui

import android.graphics.BitmapFactory
import android.util.Base64
import androidx.compose.foundation.Image
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import com.openmausbot.companion.R
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.currentStateAsState
import com.openmausbot.companion.core.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private data class BrowserImage(val bitmap: ImageBitmap, val seq: Int, val width: Int, val height: Int)

/** Dedicated native viewer. Reconnecting observes only; it never retakes control or replays input. */
@Composable
fun BrowserLiveScreen(
    botName: String,
    connectionKey: String,
    openEvents: () -> Flow<BrowserViewerEvent>,
    sendAction: suspend (String, BrowserViewerAction) -> Unit,
    onBack: () -> Unit,
    onChat: () -> Unit,
    onControlState: (Boolean, Boolean, () -> Unit) -> Unit = { _, _, _ -> },
) {
    val streamFactory by rememberUpdatedState(openEvents)
    val actionSender by rememberUpdatedState(sendAction)
    val lifecycleState by LocalLifecycleOwner.current.lifecycle.currentStateAsState()
    val active = lifecycleState.isAtLeast(Lifecycle.State.RESUMED)
    val scope = rememberCoroutineScope()
    var attempt by remember { mutableIntStateOf(0) }
    var generation by remember { mutableIntStateOf(0) }
    var frame by remember(connectionKey) { mutableStateOf<BrowserImage?>(null) }
    var tabs by remember(connectionKey) { mutableStateOf<List<BrowserViewerTab>>(emptyList()) }
    var address by remember(connectionKey) { mutableStateOf("") }
    var viewerId by remember { mutableStateOf("") }
    var connected by remember { mutableStateOf(false) }
    var current by remember { mutableStateOf(false) }
    var controlling by remember { mutableStateOf(false) }
    var held by remember { mutableStateOf(false) }
    var pending by remember { mutableStateOf(false) }
    var failure by remember { mutableStateOf<String?>(null) }
    var actionJob by remember { mutableStateOf<Job?>(null) }
    var dialog by remember { mutableStateOf<String?>(null) }
    var draft by remember { mutableStateOf("") }
    var viewSize by remember { mutableStateOf(IntSize.Zero) }
    var zoom by remember(connectionKey) { mutableFloatStateOf(1f) }
    var pan by remember(connectionKey) { mutableStateOf(Offset.Zero) }
    fun resetTransform() { zoom = 1f; pan = Offset.Zero }
    fun invalidate() {
        generation++; actionJob?.cancel(); actionJob = null
        viewerId = ""; connected = false; current = false; controlling = false; held = false; pending = false
    }
    fun schedule(action: BrowserViewerAction, success: () -> Unit = {}) {
        if (!active || !connected || pending || viewerId.isEmpty()) return
        if ((action == BrowserViewerAction.Take || action is BrowserViewerAction.Tap || action is BrowserViewerAction.Scroll) && !current) return
        if (action != BrowserViewerAction.Take && action != BrowserViewerAction.Restart && !controlling) return
        if (action == BrowserViewerAction.Take && held && !controlling) return
        val token = generation
        val id = viewerId
        val sender = actionSender
        pending = true
        actionJob = scope.launch {
            try {
                if (token != generation || viewerId != id) return@launch
                sender(id, action)
                if (token == generation && viewerId == id) success()
            } catch (error: CancellationException) { throw error
            } catch (error: Exception) { if (token == generation) failure = browserFailure(error) }
            finally { if (token == generation) { pending = false; actionJob = null } }
        }
    }
    LaunchedEffect(controlling, connected, pending, viewerId) { onControlState(controlling && connected, pending) { schedule(BrowserViewerAction.Release) } }
    DisposableEffect(connectionKey, active) {
        onDispose { invalidate() }
    }
    LaunchedEffect(connectionKey, active, attempt) {
        invalidate()
        if (!active) return@LaunchedEffect
        failure = null
        val token = generation
        val sender = actionSender
        try {
            streamFactory().collect { event ->
                if (token != generation) return@collect
                val data = event.payload
                when (event.name) {
                    "ready" -> { viewerId = data.viewerId.orEmpty(); connected = viewerId.isNotEmpty() }
                    "control" -> {
                        controlling = data.controlling == true; held = data.held == true
                        if (held && !controlling) { frame = null; tabs = emptyList(); address = ""; current = false }
                    }
                    "tabs" -> { tabs = data.tabs.orEmpty(); address = tabs.firstOrNull { it.active }?.url ?: address }
                    "url" -> address = data.url ?: address
                    "frame" -> {
                        val id = viewerId
                        current = false
                        val decoded = withContext(Dispatchers.Default) {
                            val bytes = Base64.decode(requireNotNull(data.data), Base64.DEFAULT)
                            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
                            require(bounds.outWidth in 1..8192 && bounds.outHeight in 1..8192 && bounds.outWidth.toLong() * bounds.outHeight <= 16_777_216) { "Invalid browser image size." }
                            val bitmap = requireNotNull(BitmapFactory.decodeByteArray(bytes, 0, bytes.size)) { "The browser frame could not be decoded." }
                            val size = requireNotNull(data.metadata)
                            BrowserImage(bitmap.asImageBitmap(), requireNotNull(data.seq), size.deviceWidth, size.deviceHeight)
                        }
                        if (token != generation || id != viewerId || id.isEmpty()) return@collect
                        frame = decoded
                        withFrameNanos { }
                        if (token != generation || id != viewerId) return@collect
                        sender(id, BrowserViewerAction.Acknowledge(decoded.seq))
                        if (token == generation && id == viewerId) current = true
                    }
                    "error" -> throw IllegalStateException(data.message ?: "The browser connection was interrupted.")
                    "status" -> if (data.connected == false) { connected = false; current = false; controlling = false }
                }
            }
            if (token == generation) failure = "The browser connection ended."
        } catch (error: CancellationException) { throw error
        } catch (error: Exception) { if (token == generation) failure = browserFailure(error) }
        finally { if (token == generation) invalidate() }
    }
    val usable = active && connected && controlling && !pending
    val status = when {
        !connected -> if (failure == null) "connecting" else if (frame == null) "offline" else "offline · last frame"
        held && !controlling -> "another view has control"
        !current -> "waiting for a frame"
        controlling -> "your control"
        else -> "watching $botName"
    }
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back to chat") }
            TextButton(onClick = { draft = address; dialog = "address" }, modifier = Modifier.weight(1f), enabled = connected) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(runCatching { java.net.URI(address).host }.getOrNull() ?: "browser", maxLines = 1)
                    Text(status, style = MaterialTheme.typography.labelSmall)
                }
            }
            IconButton(onClick = { dialog = "options" }) { Icon(Icons.Filled.MoreVert, "Browser options") }
        }
        Box(Modifier.weight(1f).fillMaxWidth().clipToBounds().background(Color.Black).onSizeChanged { viewSize = it }, contentAlignment = Alignment.Center) {
            val displayed = frame
            if (displayed == null) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    if (failure == null) CircularProgressIndicator()
                    Text(if (failure == null) "Opening the live browser…" else "Browser unavailable", color = Color.White)
                }
            } else {
                val gestures = if (controlling) {
                    Modifier.pointerInput(displayed.seq, usable) {
                        detectTapGestures { point ->
                            if (usable && current) browserPagePoint(point.x, point.y, viewSize.width, viewSize.height, displayed.width, displayed.height)?.let { (x, y) -> schedule(BrowserViewerAction.Tap(displayed.seq, x, y)) }
                        }
                    }.pointerInput(displayed.seq, usable) {
                        var start = Offset.Zero; var distance = Offset.Zero
                        detectDragGestures(onDragStart = { start = it; distance = Offset.Zero }, onDragCancel = { distance = Offset.Zero }, onDragEnd = {
                            if (usable && current) browserPagePoint(start.x, start.y, viewSize.width, viewSize.height, displayed.width, displayed.height)?.let { (x, y) -> schedule(BrowserViewerAction.Scroll(displayed.seq, x, y, -distance.x.toDouble(), -distance.y.toDouble())) }
                        }) { change, amount -> if (usable) { change.consume(); distance += amount } }
                    }
                } else Modifier.pointerInput(Unit) {
                    detectTransformGestures { _, movement, scale, _ -> zoom = (zoom * scale).coerceIn(1f, 4f); pan = if (zoom > 1f) pan + movement else Offset.Zero }
                }
                Image(displayed.bitmap, "Live browser page", contentScale = ContentScale.Fit,
                    modifier = Modifier.fillMaxSize().then(gestures).graphicsLayer {
                        scaleX = zoom; scaleY = zoom; translationX = pan.x; translationY = pan.y
                        alpha = if (connected && current) 1f else .55f; clip = true
                    })
            }
        }
        failure?.let { message -> Column(Modifier.fillMaxWidth().padding(12.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Text(message, style = MaterialTheme.typography.bodySmall)
            TextButton(onClick = { attempt++ }) { Text(localized("Reconnect browser")) }
        } }
        Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = { schedule(BrowserViewerAction.Back) }, enabled = usable) { Icon(Icons.AutoMirrored.Filled.KeyboardArrowLeft, "Browser back") }
            IconButton(onClick = { schedule(BrowserViewerAction.Forward) }, enabled = usable) { Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, "Browser forward") }
            Spacer(Modifier.weight(1f))
            IconButton(onClick = { dialog = "tabs" }, modifier = Modifier.semantics { contentDescription = "Browser tabs" }) {
                Box {
                    val tint = LocalContentColor.current
                    Canvas(Modifier.size(22.dp)) {
                        drawRect(tint, topLeft = Offset(size.width * .2f, 0f), size = Size(size.width * .8f, size.height * .8f), style = Stroke(1.5.dp.toPx()))
                        drawRect(tint, topLeft = Offset(0f, size.height * .2f), size = Size(size.width * .8f, size.height * .8f), style = Stroke(1.5.dp.toPx()))
                    }
                    Text(localized("${tabs.size}"), Modifier.align(Alignment.TopEnd), style = MaterialTheme.typography.labelSmall)
                }
            }
            IconButton(onClick = onChat) { Icon(painterResource(R.drawable.ic_chat_bubbles), "Open chat sheet", modifier = Modifier.size(22.dp)) }
            OutlinedButton(onClick = { schedule(if (controlling) BrowserViewerAction.Release else BrowserViewerAction.Take) { resetTransform() } },
                enabled = active && connected && current && !pending && (!held || controlling), contentPadding = PaddingValues(horizontal = 10.dp), modifier = Modifier.heightIn(min = 44.dp)) {
                if (pending) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                else Text(if (controlling) "give back" else "take control", style = MaterialTheme.typography.labelSmall)
            }
        }
    }
    when (dialog) {
        "address", "keyboard" -> AlertDialog(onDismissRequest = { dialog = null }, title = { Text(if (dialog == "address") "Open a page" else "Type in the focused page field") },
            text = { Column { OutlinedTextField(draft, { draft = it }, keyboardOptions = KeyboardOptions(keyboardType = if (dialog == "address") KeyboardType.Uri else KeyboardType.Text, autoCorrectEnabled = dialog != "address"), label = { Text(if (dialog == "address") "Address or search" else "Text") }); if (dialog == "keyboard") Text(localized("Tap the page field first. Use the website's sign-in flow for passwords.")); if (!controlling) Text(localized("Take control to navigate.")) } },
            confirmButton = { TextButton(enabled = usable, onClick = { val action = if (dialog == "address") BrowserViewerAction.Navigate(browserNavigationURL(draft)) else BrowserViewerAction.Text(draft); dialog = null; schedule(action) }) { Text(if (dialog == "address") "go" else "type") } },
            dismissButton = { Row { if (dialog == "keyboard") TextButton(enabled = usable, onClick = { dialog = null; schedule(BrowserViewerAction.Enter) }) { Text(localized("enter")) }; TextButton(onClick = { dialog = null }) { Text(localized("cancel")) } } })
        "tabs" -> AlertDialog(onDismissRequest = { dialog = null }, title = { Text(localized("browser tabs")) }, text = {
            LazyColumn { items(tabs, key = { it.tabId }) { tab -> Row(verticalAlignment = Alignment.CenterVertically) {
                TextButton(enabled = usable, onClick = { schedule(BrowserViewerAction.SelectTab(tab.tabId)) { dialog = null; resetTransform() } }, modifier = Modifier.weight(1f)) { Text((if (tab.active) "active · " else "") + tab.title.ifEmpty { "New tab" }, maxLines = 2) }
                TextButton(enabled = usable, onClick = { schedule(BrowserViewerAction.CloseTab(tab.tabId)) }) { Text(localized("close")) }
            } }; if (!controlling) item { Text(localized("Take control to switch tabs.")) } }
        }, confirmButton = { TextButton(onClick = { dialog = null }) { Text(localized("done")) } }, dismissButton = { TextButton(enabled = usable, onClick = { schedule(BrowserViewerAction.NewTab) }) { Text(localized("new tab")) } })
        "options" -> AlertDialog(onDismissRequest = { dialog = null }, title = { Text(localized("browser options")) }, text = { Column {
            TextButton(onClick = { dialog = null; attempt++ }) { Text(localized("reconnect view")) }
            TextButton(enabled = usable, onClick = { dialog = null; schedule(BrowserViewerAction.Reload) }) { Text(localized("reload page")) }
            TextButton(onClick = { dialog = null; resetTransform() }) { Text(localized("fit page")) }
            TextButton(enabled = usable, onClick = { draft = ""; dialog = "keyboard" }) { Text(localized("type in page")) }
            TextButton(enabled = active && connected && !pending, onClick = { dialog = "restart" }) { Text(localized("restart browser session")) }
        } }, confirmButton = { TextButton(onClick = { dialog = null }) { Text(localized("done")) } })
        "restart" -> AlertDialog(onDismissRequest = { dialog = null }, title = { Text(localized("Restart this browser session?")) }, text = { Text(localized("This closes its open pages. Active bot work must finish first.")) }, confirmButton = { TextButton(onClick = { dialog = null; schedule(BrowserViewerAction.Restart) { attempt++ } }) { Text(localized("restart browser")) } }, dismissButton = { TextButton(onClick = { dialog = null }) { Text(localized("cancel")) } })
    }
}

private fun browserFailure(error: Exception): String = if (error is APIError.Status && error.code == 403)
    "Enable computer access for this device in BOS settings." else error.message ?: "Browser unavailable. Reconnect before trying again."
