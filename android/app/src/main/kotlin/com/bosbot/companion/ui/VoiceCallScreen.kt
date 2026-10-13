package com.openmausbot.companion.ui

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import com.openmausbot.companion.audio.*
import kotlinx.coroutines.flow.Flow
import kotlinx.serialization.json.*

@Composable
fun VoiceCallScreen(
    botName: String,
    onClose: () -> Unit,
    startCall: suspend (String, String) -> JsonObject,
    sendTask: suspend (String, String) -> String?,
    recall: () -> JsonObject,
    reportUsage: suspend (String, Int) -> Unit,
    opener: String? = null,
    target: VoiceCallTarget = VoiceCallTarget("local", botName, "default", botName),
    settledReplies: Flow<LandedVoiceReply>? = null,
    ownerConnection: kotlinx.coroutines.flow.StateFlow<com.openmausbot.companion.core.Connection?>? = null,
    ownerRuntimeRevision: kotlinx.coroutines.flow.StateFlow<Long>? = null,
    onMinimize: () -> Unit = onClose,
    sendSpokenTask: (suspend (String, String, String) -> String?)? = null,
    autoStart: Boolean = opener != null,
) {
    val context = LocalContext.current
    val center = remember { VoiceCallCenter.get(context) }
    val lifecycle = androidx.lifecycle.compose.LocalLifecycleOwner.current.lifecycle
    var active by remember(target) { mutableStateOf(true) }
    DisposableEffect(target) { onDispose { active = false } }
    var call by remember(target) { mutableStateOf(
        center.call.value?.takeIf { center.target.value == target }
            ?: RealtimeAudioCall(context, startCall, sendTask, recall, reportUsage)
    ) }
    val state by call.state.collectAsState()
    val saved = remember(target) { center.savedSettings(target) }
    var voice by remember(target) { mutableStateOf(saved.voice) }
    var language by remember(target) { mutableStateOf(saved.language) }
    var speed by remember(target) { mutableStateOf(saved.speed.toFloat()) }
    var showSettings by remember { mutableStateOf(false) }
    var showHistory by remember { mutableStateOf(false) }
    val history by center.history.collectAsState()
    val openingRevision = remember(target, ownerRuntimeRevision) { ownerRuntimeRevision?.value }
    fun begin() {
        if (!active || (ownerConnection != null && ownerConnection.value?.id != target.connectionId) ||
            (ownerRuntimeRevision != null && ownerRuntimeRevision.value != openingRevision)) return
        call = center.start(target, startCall, sendTask, recall, reportUsage,
            VoiceSettings(voice, speed.toDouble(), language), opener, settledReplies, sendSpokenTask, ownerConnection = ownerConnection, ownerRuntimeRevision = ownerRuntimeRevision)
    }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted -> if (granted && active && lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.STARTED) && (ownerConnection == null || ownerConnection.value?.id == target.connectionId)) begin() }
    LaunchedEffect(target, autoStart) {
        if (autoStart && state.phase == "ready") {
            if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) begin()
            else permission.launch(Manifest.permission.RECORD_AUDIO)
        }
    }
    BackHandler {
        if (state.phase in listOf("live", "connecting", "reconnecting")) { center.minimize(); onMinimize() }
        else { center.dismiss(); onClose() }
    }
    LaunchedEffect(state.settings) {
        if (state.phase != "ready") {
            voice = state.settings.voice; language = state.settings.language; speed = state.settings.speed.toFloat()
            center.saveSettings(target, state.settings)
        }
    }
    Column(Modifier.fillMaxSize().padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(botName, style = MaterialTheme.typography.headlineMedium)
            TextButton(onClick = { center.minimize(); onMinimize() }, enabled = state.phase in listOf("live", "connecting", "reconnecting")) { Text(localized("minimize")) }
        }
        Text(localized("${state.phase} · ${state.seconds / 60}:${(state.seconds % 60).toString().padStart(2, '0')}"))
        state.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        Row {
            TextButton(onClick = { showSettings = !showSettings }) { Text(localized("voice settings")) }
            TextButton(onClick = { showHistory = !showHistory }) { Text(localized("call history")) }
        }
        if (state.phase == "ready" || showSettings) {
            VoiceOptionPicker("voice", voice, (state.options?.get("voices") as? JsonArray)?.map { it.jsonPrimitive.content }.orEmpty().ifEmpty { VoiceChoices.voices }) { voice = it }
            VoiceOptionPicker("language", language, (state.options?.get("languages") as? JsonArray)?.map { it.jsonPrimitive.content }.orEmpty().ifEmpty { VoiceChoices.languages }) { language = it }
            VoiceOptionPicker("speed", speed.toString(), (state.options?.get("speeds") as? JsonArray)?.map { it.jsonPrimitive.content }.orEmpty().ifEmpty { VoiceChoices.speeds.map { it.toString() } }) { speed = it.toFloatOrNull() ?: 1f }
            if (state.phase != "ready") Button(onClick = {
                call.updateSettings(VoiceSettings(voice, speed.toDouble(), language)); showSettings = false
            }) { Text(localized("apply")) }
        }
        if (state.phase == "ready") Button(onClick = {
            if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) begin()
            else permission.launch(Manifest.permission.RECORD_AUDIO)
        }) { Text(localized("call")) }
        LinearProgressIndicator(progress = { state.level.coerceIn(0f, 1f) }, modifier = Modifier.fillMaxWidth())
        LazyColumn(Modifier.weight(1f)) {
            if (showHistory) {
                items(history.filter { it.connectionId == target.connectionId && it.botId == target.botId && it.threadId == target.threadId }.reversed(), key = { it.id }) { record ->
                    Column(Modifier.padding(vertical = 8.dp)) {
                        Text(localized("${java.text.DateFormat.getDateTimeInstance().format(java.util.Date(record.endedAt))} · ${record.seconds}s"), style = MaterialTheme.typography.labelSmall)
                        record.transcript.forEach { Text(localized("${it.speaker}: ${it.text}")) }
                    }
                }
            } else items(state.lines, key = { it.speaker + it.id }) { line ->
                Column(Modifier.padding(vertical = 8.dp)) {
                    Text(line.speaker, style = MaterialTheme.typography.labelSmall); Text(line.text)
                }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Button(onClick = { call.mute() }, enabled = state.phase == "live") { Text(if (state.muted) "unmute" else "mute") }
            TextButton(onClick = { call.toggleSpeaker() }, enabled = state.phase == "live") { Text(if (state.speakerphone) "speaker" else "earpiece") }
            Button(onClick = { call.hangUp(); center.dismiss(); onClose() }) { Text(if (state.phase == "ended" || state.phase == "failed" || state.phase == "ready") "done" else "hang up") }
        }
    }
}

/** Root hosts this above navigation whenever the center's presentation is MINIMIZED. */
@Composable
fun MinimizedVoiceCall(onExpand: (VoiceCallTarget) -> Unit) {
    val context = LocalContext.current
    val center = remember { VoiceCallCenter.get(context) }
    val presentation by center.presentation.collectAsState()
    val call by center.call.collectAsState()
    val target by center.target.collectAsState()
    if (presentation == VoiceCallCenter.Presentation.MINIMIZED && call != null && target != null) {
        val state by call!!.state.collectAsState()
        Surface(tonalElevation = 6.dp) {
            Row(Modifier.fillMaxWidth().padding(10.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                TextButton(onClick = { center.expand(); onExpand(target!!) }) { Text(localized("${target!!.botName} · ${state.phase} · ${state.seconds}s")) }
                TextButton(onClick = { center.hangUp(); center.dismiss() }) { Text(localized("hang up")) }
            }
        }
    }
}

/** Root feeds SSE/push rings into center.ring and routes answer to the ring's exact target. */
@Composable
fun IncomingVoiceCallOverlay(onAnswer: (IncomingVoiceCall) -> Unit) {
    val context = LocalContext.current
    val center = remember { VoiceCallCenter.get(context) }
    val ring by center.incoming.collectAsState()
    ring?.let { incoming ->
        AlertDialog(onDismissRequest = { center.declineRing() },
            title = { Text(localized("${incoming.target.botName} is calling")) },
            text = { Text(incoming.reason) },
            confirmButton = { TextButton(onClick = { center.takeRing()?.let(onAnswer) }) { Text(localized("answer")) } },
            dismissButton = { TextButton(onClick = { center.declineRing() }) { Text(localized("decline")) } })
    }
}

@Composable
private fun VoiceOptionPicker(label: String, selected: String, choices: List<String>, onSelect: (String) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    Box {
        OutlinedButton(onClick = { expanded = true }) { Text(localized("$label · $selected")) }
        DropdownMenu(expanded, { expanded = false }) {
            choices.forEach { choice -> DropdownMenuItem(text = { Text(choice) }, onClick = { onSelect(choice); expanded = false }) }
        }
    }
}
