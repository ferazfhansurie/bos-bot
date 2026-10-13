package com.openmausbot.companion.ui

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.*
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.openmausbot.companion.audio.VoiceCallCenter
import com.openmausbot.companion.audio.WalkiePlayback
import com.openmausbot.companion.core.*
import com.openmausbot.companion.dictation.WalkieSpeechCapture
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private data class WalkiePending(val chat: Chat, val baseline: Set<String>, val sentAt: Long)
private fun Chat.walkieName() = when (this) { is Chat.BotChat -> bot.name; is Chat.RoomChat -> room.name }

@Composable
fun WalkieScreen(session: Session, initialChat: Chat? = null, onClose: () -> Unit, onOpen: (Chat) -> Unit) {
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current
    val scope = rememberCoroutineScope()
    val snapshot by session.state.collectAsState()
    val connection by session.connection.collectAsState()
    val openingConnection = remember(session) { session.connection.value?.id }
    val capture = remember(session) { WalkieSpeechCapture(context.applicationContext) }
    val playback = remember { WalkiePlayback(context.applicationContext) }
    val speech by capture.state.collectAsState()
    var target by remember(session) { mutableStateOf(initialChat) }
    var phase by remember { mutableStateOf("idle") }
    var draft by remember { mutableStateOf("") }
    var heard by remember { mutableStateOf("") }
    var reply by remember { mutableStateOf("") }
    var replyFrom by remember { mutableStateOf("") }
    var replyChat by remember { mutableStateOf<Chat?>(null) }
    var speechGeneration by remember { mutableIntStateOf(0) }
    var note by remember { mutableStateOf<String?>(null) }
    var speakReplies by remember { mutableStateOf(context.getSharedPreferences("walkie", 0).getBoolean("speakReplies", true)) }
    var pending by remember { mutableStateOf<WalkiePending?>(null) }
    var speechJob by remember { mutableStateOf<Job?>(null) }
    var pressing by remember { mutableStateOf(false) }
    var retainedSend by remember { mutableStateOf<Pair<String, String>?>(null) }
    val roster = snapshot.bots.filter { it.hidden != true }.map { Chat.BotChat(it) as Chat } + snapshot.rooms.map { Chat.RoomChat(it) as Chat }
    fun stopSpeech() { speechGeneration++; speechJob?.cancel(); speechJob = null; playback.stop(); if (phase == "speaking") phase = "idle" }
    fun say(text: String, chat: Chat?) {
        stopSpeech()
        phase = "speaking"
        val generation = speechGeneration
        speechJob = scope.launch {
            try {
                if (session.connection.value?.id != openingConnection) throw CancellationException("The selected computer changed.")
                val parts = Walkie.utterances(Walkie.speakable(text))
                val config = session.configStatus()
                val voice = (chat as? Chat.BotChat)?.bot?.voice ?: config?.tts?.voice
                if (config?.isTTSConfigured == true && openingConnection != null) {
                    for ((index, part) in parts.withIndex()) {
                        try { playback.play(session.walkieSpeech(part, voice, openingConnection)) }
                        catch (error: Throwable) {
                            if (error is CancellationException) throw error
                            if (session.connection.value?.id != openingConnection) throw CancellationException("The selected computer changed.")
                            note = "Using the phone's voice."
                            playback.speak(parts.drop(index).joinToString(" ")); break
                        }
                    }
                } else playback.speak(parts.joinToString(" "))
            } catch (error: Throwable) {
                if (error is CancellationException) throw error
                note = error.message ?: "Couldn't read the reply aloud."
            } finally { if (generation == speechGeneration && phase == "speaking") phase = "idle" }
        }
    }
    fun beginCapture() {
        if (session.connection.value?.id != openingConnection) { note = "The selected computer changed."; return }
        if (target == null || phase in listOf("review", "sending", "transcribing")) return
        if (VoiceCallCenter.get(context).call.value?.state?.value?.phase in listOf("live", "connecting", "reconnecting")) {
            note = "End the call before using walkie."; return
        }
        stopSpeech(); note = null; capture.start()
    }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted && pressing) beginCapture() else if (!granted) note = "Walkie needs microphone access."
    }
    fun beginPress() {
        if (target == null) { note = "Pick someone to talk to first."; return }
        if (session.connection.value?.id != openingConnection) { note = "The selected computer changed."; return }
        pressing = true
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) beginCapture()
        else permission.launch(Manifest.permission.RECORD_AUDIO)
    }
    fun finishPress(released: Boolean) {
        pressing = false
        if (released) capture.release() else { capture.cancel(); if (phase in listOf("listening", "transcribing")) phase = "idle" }
    }
    LaunchedEffect(speech) {
        if (speech.phase in listOf("listening", "transcribing")) { phase = speech.phase; heard = speech.text }
        else if (speech.phase == "review") { heard = speech.text; draft = speech.text; phase = "review" }
        if (speech.phase == "idle" && phase in listOf("listening", "transcribing")) phase = "idle"
        speech.error?.let { note = it; phase = "idle" }
    }
    LaunchedEffect(roster.map { it.id }) { if (target == null) target = roster.firstOrNull() }
    LaunchedEffect(snapshot, pending) {
        val waiting = pending ?: return@LaunchedEffect
        if (phase != "waiting") return@LaunchedEffect
        val answer = Walkie.settledReply(snapshot.transcript(waiting.chat.threadId), waiting.baseline, Walkie.busy(snapshot, waiting.chat)) ?: return@LaunchedEffect
        pending = null; reply = answer; replyFrom = waiting.chat.walkieName(); replyChat = waiting.chat
        if (speakReplies) say(answer, waiting.chat) else phase = "idle"
    }
    LaunchedEffect(pending?.sentAt) {
        val waiting = pending ?: return@LaunchedEffect
        delay(10 * 60 * 1000L)
        if (pending === waiting) { pending = null; phase = "idle"; note = "${waiting.chat.walkieName()} is still working. The answer will be in the chat." }
    }
    LaunchedEffect(connection?.id) {
        if (connection?.id != openingConnection) {
            capture.cancel(); stopSpeech(); pending = null; reply = ""; replyChat = null; target = null; phase = "idle"; note = "The selected computer changed. Reopen walkie for that computer."
        }
    }
    DisposableEffect(lifecycle) {
        val observer = object : DefaultLifecycleObserver {
            override fun onStop(owner: LifecycleOwner) { capture.cancel(); stopSpeech(); pressing = false; if (phase in listOf("listening", "transcribing")) phase = "idle" }
        }
        lifecycle.lifecycle.addObserver(observer)
        onDispose { lifecycle.lifecycle.removeObserver(observer); capture.cancel(); speechJob?.cancel(); playback.close() }
    }
    BackHandler { onClose() }
    Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) { Text("walkie", style = MaterialTheme.typography.headlineMedium); TextButton(onClick = onClose) { Text("done") } }
        Text(connection?.name.orEmpty(), style = MaterialTheme.typography.labelMedium)
        LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            items(roster, key = { it.id }) { chat ->
                TextButton(onClick = { if (phase !in listOf("review", "sending", "listening", "transcribing")) target = chat }, enabled = phase !in listOf("review", "sending", "listening", "transcribing"), modifier = Modifier.fillMaxWidth()) {
                    Text("${if (target?.id == chat.id) "• " else ""}${chat.walkieName()} · ${if (Walkie.busy(snapshot, chat)) "working" else "ready"}")
                }
            }
        }
        Text(when (phase) { "listening" -> "listening"; "transcribing" -> "finishing transcript"; "review" -> "check the words"; "sending" -> "sending"; "waiting" -> "waiting for ${pending?.chat?.walkieName().orEmpty()}"; "speaking" -> replyFrom; else -> target?.walkieName() ?: "pick someone to talk to" }, style = MaterialTheme.typography.titleMedium)
        note?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        if (phase in listOf("listening", "transcribing", "waiting")) Text(heard.ifBlank { "go ahead…" })
        if (reply.isNotBlank() && phase !in listOf("review", "sending", "listening", "transcribing")) Text(Walkie.speakable(reply, 400))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            TextButton(onClick = { target?.let(onOpen) }, enabled = target != null) { Text("chat") }
            TextButton(onClick = { say(reply, replyChat) }, enabled = reply.isNotBlank()) { Text("replay") }
            TextButton(onClick = {
                if (phase == "speaking") stopSpeech() else target?.let { chat -> scope.launch {
                    try { openingConnection?.let { session.stopWalkie(chat, it) }; pending = null; phase = "idle" }
                    catch (error: Throwable) { if (error is CancellationException) throw error; note = error.message }
                } }
            }, enabled = phase == "speaking" || target?.let { Walkie.busy(snapshot, it) } == true) { Text("stop") }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text("speak replies"); Switch(checked = speakReplies, onCheckedChange = { on -> speakReplies = on; context.getSharedPreferences("walkie", 0).edit().putBoolean("speakReplies", on).apply(); if (!on) stopSpeech() })
        }
        if (phase in listOf("review", "sending")) {
            OutlinedTextField(value = draft, onValueChange = { draft = it }, modifier = Modifier.fillMaxWidth(), label = { Text("what to send") }, enabled = phase != "sending")
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                TextButton(onClick = { draft = ""; heard = ""; capture.cancel(); phase = "idle"; retainedSend = null }, enabled = phase != "sending") { Text("discard") }
                Button(onClick = {
                    val chat = target ?: return@Button
                    val words = draft.trim()
                    val key = "${chat.id}:${chat.threadId}:$words"
                    val sendId = retainedSend?.takeIf { it.first == key }?.second ?: UUID.randomUUID().toString()
                    retainedSend = key to sendId; phase = "sending"; note = null
                    val baseline = snapshot.transcript(chat.threadId).mapTo(mutableSetOf(), Message::id)
                    scope.launch {
                        if (session.connection.value?.id != openingConnection) { note = "The selected computer changed."; phase = "review"; return@launch }
                        if (session.send(words, emptyList(), chat, durableSendId = sendId)) {
                            heard = words; draft = ""; retainedSend = null; reply = ""
                            if (session.connection.value?.id == openingConnection) {
                                phase = "waiting"; pending = WalkiePending(chat, baseline, System.currentTimeMillis())
                            } else { phase = "idle"; pending = null; note = "Sent to the previous computer. Open that chat for the reply." }
                        } else { phase = "review"; note = session.actionError ?: "The message could not be sent. Your words are still here." }
                    }
                }, enabled = draft.isNotBlank() && phase != "sending" && connection?.id == openingConnection) { Text(if (phase == "sending") "sending…" else "send") }
            }
        } else {
            Surface(Modifier.fillMaxWidth().height(68.dp).semantics {
                contentDescription = "hold to talk; release to review"
                onClick(label = if (speech.phase == "listening") "finish and review" else "start talking") {
                    if (speech.phase == "listening") finishPress(true) else beginPress(); true
                }
            }.pointerInput(target?.id, connection?.id) { detectTapGestures(onPress = {
                if (phase !in listOf("review", "sending", "transcribing") && connection?.id == openingConnection) {
                    beginPress()
                    var released = false
                    try { released = tryAwaitRelease() } finally { finishPress(released) }
                }
            }) }, color = if (phase == "listening") MaterialTheme.colorScheme.errorContainer else MaterialTheme.colorScheme.primaryContainer) {
                Box(Modifier.fillMaxSize().padding(18.dp)) { Text(if (phase == "listening") "release to review" else if (phase == "transcribing") "finishing transcript…" else "hold to talk") }
            }
        }
    }
}
