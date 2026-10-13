package com.openmausbot.companion.ui

import android.Manifest
import android.content.pm.PackageManager
import android.media.MediaPlayer
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.openmausbot.companion.audio.RecordingCenter
import java.io.File
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.first

/** Audio stays on the phone on dismiss/background; explicit send uploads through the caller. */
@Composable
fun RecordingScreen(onClose: () -> Unit, onSend: suspend (File, String, Boolean) -> Boolean, initialLibrary: Boolean = false, autoStart: Boolean = false, initialMeeting: Boolean = false) {
    val context = LocalContext.current
    val recorder = remember { RecordingCenter.recorder(context) }
    val state by recorder.state.collectAsState()
    val meeting = state.meetingMode
    var library by remember { mutableStateOf(initialLibrary) }
    var sending by remember { mutableStateOf(false) }
    var sendRequested by remember { mutableStateOf(false) }
    var sendError by remember { mutableStateOf<String?>(null) }
    var draft by remember { mutableStateOf("") }
    var selectedFile by remember { mutableStateOf<File?>(null) }
    var player by remember { mutableStateOf<MediaPlayer?>(null) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var active by remember { mutableStateOf(true) }
    var closing by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    fun closeRecorder() {
        if (closing) return
        closing = true; recorder.stop()
        scope.launch {
            recorder.state.first { !it.recording && !it.finishing }
            recorder.setMeetingMode(false); onClose()
        }
    }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted -> if (granted && active && lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) recorder.start() }
    fun start() {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) recorder.start()
        else permission.launch(Manifest.permission.RECORD_AUDIO)
    }
    DisposableEffect(Unit) {
        onDispose { active = false; player?.release(); player = null }
    }
    LaunchedEffect(autoStart, initialLibrary) {
        if (autoStart && !initialLibrary && !state.recording) { recorder.setMeetingMode(initialMeeting); start() }
    }
    LaunchedEffect(state.file) { if (state.file != null) { selectedFile = state.file; draft = "" } }
    LaunchedEffect(state.transcript) { if (state.transcript.isNotEmpty()) draft = state.transcript }
    LaunchedEffect(draft, selectedFile, state.recording, state.finishing) {
        if (!state.recording && !state.finishing) selectedFile?.let { file ->
            runCatching { File(file.parentFile, file.nameWithoutExtension + ".txt").writeText(draft) }
        }
    }
    LaunchedEffect(sendRequested) {
        if (sendRequested) {
            sending = true
            try {
                val file = selectedFile
                if (file != null && run {
                    runCatching { File(file.parentFile, file.nameWithoutExtension + ".txt").writeText(draft) }
                    onSend(file, draft, meeting)
                }) onClose() else sendError = "Could not confirm delivery. Your recording is saved on this phone."
            } catch (_: Exception) { sendError = "Could not confirm delivery. Your recording is saved on this phone." }
            finally { sending = false; sendRequested = false }
        }
    }
    BackHandler { closeRecorder() }
    Column(Modifier.fillMaxSize().padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(if (meeting) "meeting recording" else "voice draft", style = MaterialTheme.typography.titleLarge)
            TextButton(onClick = { closeRecorder() }, enabled = !sending && !closing) { Text(localized("done")) }
        }
        Text(when { state.recording -> "recording · ${state.seconds / 60}:${(state.seconds % 60).toString().padStart(2, '0')}"
            state.finishing -> "finishing transcript"
            state.file != null -> "saved on this phone"
            else -> "ready to record" })
        LinearProgressIndicator(progress = { state.level.coerceIn(0f, 1f) }, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(draft, { draft = it }, Modifier.fillMaxWidth().weight(1f),
            enabled = !state.recording && !state.finishing,
            label = { Text(localized("transcript")) }, placeholder = { Text(localized("audio is saved independently of transcription")) })
        state.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        sendError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Switch(meeting, { recorder.setMeetingMode(it) })
            Text(localized("meeting mode"))
        }
        if (meeting) Text(localized("Let everyone know you’re recording. Keeps recording while your phone locks; use the microphone notification to stop."), style = MaterialTheme.typography.bodySmall)
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Button(onClick = { if (state.recording) recorder.stop() else start() }, enabled = !state.finishing && !sending) { Text(if (state.recording) "stop" else "record") }
            Button(onClick = { sendRequested = true }, enabled = selectedFile?.let { it.length() > 44 } == true && !state.recording && !state.finishing && !sending) { Text(if (sending) "sending" else "send") }
            TextButton(onClick = { library = !library }, enabled = !state.recording) { Text(localized("recordings")) }
        }
        if (library) Column(Modifier.heightIn(max = 180.dp).verticalScroll(rememberScrollState())) {
            recorder.recordings().forEach { file ->
                TextButton(onClick = {
                    player?.release()
                    runCatching {
                        player = MediaPlayer().apply {
                            setDataSource(file.absolutePath); prepare(); start()
                            setOnCompletionListener { it.release(); player = null }
                        }
                    }.onFailure { sendError = "Unable to play this recording" }
                }) { Text(localized("play · ${file.name}")) }
                TextButton(onClick = {
                    selectedFile = file
                    draft = runCatching { File(file.parentFile, file.nameWithoutExtension + ".txt").readText() }.getOrDefault("")
                    library = false
                }) { Text(localized("use this recording")) }
            }
        }
    }
}
