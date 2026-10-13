package com.openmausbot.companion.audio

import android.content.Context
import com.openmausbot.companion.core.Connection
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*

object VoiceChoices {
    val voices = listOf("altair", "ara", "atlas", "aurora", "carina", "castor", "celeste", "cosmo", "eve", "helios", "helix", "iris", "kepler", "leo", "liora", "lumen", "luna", "lux", "naksh", "orion", "perseus", "rex", "rigel", "sal", "sirius", "ursa", "zagan", "zenith")
    val speeds = listOf(0.75, 1.0, 1.25, 1.5, 2.0)
    val languages = listOf("auto", "en", "ms", "zh", "id", "ta")
}

@Serializable
data class VoiceSettings(val voice: String = "liora", val speed: Double = 1.0, val language: String = "auto") {
    fun normalized(options: JsonObject?): VoiceSettings {
        fun strings(key: String) = (options?.get(key) as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }.orEmpty()
        val voices = strings("voices").ifEmpty { VoiceChoices.voices }
        val languages = strings("languages").ifEmpty { VoiceChoices.languages }
        val speeds = (options?.get("speeds") as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.doubleOrNull?.takeIf(Double::isFinite) }.orEmpty().ifEmpty { VoiceChoices.speeds }
        return copy(voice = if (voices.isEmpty() || voice in voices) voice else if ("liora" in voices) "liora" else voices.first(),
            speed = speeds.minByOrNull { kotlin.math.abs(it - speed) } ?: speed.coerceIn(0.75, 2.0),
            language = if (languages.isEmpty() || language in languages) language else "auto")
    }
}

@Serializable
data class VoiceCallHistory(val id: String, val connectionId: String, val botId: String, val threadId: String,
    val endedAt: Long, val seconds: Int, val transcript: List<RealtimeAudioCall.Line>)
data class LandedVoiceReply(val id: String, val text: String, val at: Long)
data class VoiceCallTarget(val connectionId: String, val botId: String, val threadId: String, val botName: String)

/** One app-wide call. Navigation only changes its presentation; the microphone service owns capture. */
class VoiceCallCenter private constructor(context: Context) {
    enum class Presentation { CLOSED, FULL, MINIMIZED }
    private val app = context.applicationContext
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val preferences = app.getSharedPreferences("voice-calls", Context.MODE_PRIVATE)
    private val json = Json { ignoreUnknownKeys = true }
    private val mutableCall = MutableStateFlow<RealtimeAudioCall?>(null)
    val call = mutableCall.asStateFlow()
    private val mutableTarget = MutableStateFlow<VoiceCallTarget?>(null)
    val target = mutableTarget.asStateFlow()
    private val mutablePresentation = MutableStateFlow(Presentation.CLOSED)
    val presentation = mutablePresentation.asStateFlow()
    private val mutableHistory = MutableStateFlow(runCatching { json.decodeFromString<List<VoiceCallHistory>>(preferences.getString("history", "[]")!!) }.getOrDefault(emptyList()))
    val history = mutableHistory.asStateFlow()
    private var observation: Job? = null
    private var revisionObservation: Job? = null
    private val mutableIncoming = MutableStateFlow<IncomingVoiceCall?>(null)
    val incoming = mutableIncoming.asStateFlow()
    private val seenRings = mutableSetOf<String>()
    private var ringTimeout: Job? = null
    private var ringtone: android.media.Ringtone? = null
    private var replies: Job? = null

    fun savedSettings(target: VoiceCallTarget): VoiceSettings = runCatching {
        json.decodeFromString<VoiceSettings>(preferences.getString(settingsKey(target), "{}")!!)
    }.getOrDefault(VoiceSettings())
    fun saveSettings(target: VoiceCallTarget, settings: VoiceSettings) {
        preferences.edit().putString(settingsKey(target), json.encodeToString(settings)).apply()
    }
    fun start(
        target: VoiceCallTarget,
        startCall: suspend (String, String) -> JsonObject,
        sendTask: suspend (String, String) -> String?,
        recall: () -> JsonObject,
        reportUsage: suspend (String, Int) -> Unit,
        settings: VoiceSettings = savedSettings(target),
        opener: String? = null,
        settledReplies: Flow<LandedVoiceReply>? = null,
        sendSpokenTask: (suspend (String, String, String) -> String?)? = null,
        ownerConnection: StateFlow<Connection?>? = null,
        ownerRuntimeRevision: StateFlow<Long>? = null,
    ): RealtimeAudioCall {
        val existing = call.value
        if (existing != null && existing.state.value.phase !in listOf("ended", "failed") && this.target.value == target) {
            expand(); return existing
        }
        existing?.hangUp()
        observation?.cancel(); revisionObservation?.cancel(); replies?.cancel()
        saveSettings(target, settings)
        val call = RealtimeAudioCall(app, startCall, sendTask, recall, reportUsage, sendSpokenTask)
        mutableCall.value = call; mutableTarget.value = target; mutablePresentation.value = Presentation.FULL
        call.onEnded = { ended ->
            if (call.hasBeenLive) {
                val record = VoiceCallHistory(call.callId, target.connectionId, target.botId, target.threadId,
                    System.currentTimeMillis(), ended.seconds, ended.lines)
                mutableHistory.update { records -> (records.filterNot { it.id == record.id } + record).takeLast(200) }
                preferences.edit().putString("history", json.encodeToString(history.value)).apply()
            }
            if (mutableCall.value === call) {
                observation?.cancel(); observation = null
                revisionObservation?.cancel(); revisionObservation = null
                replies?.cancel()
                mutablePresentation.value = Presentation.FULL
            }
        }
        if (settledReplies != null) replies = scope.launch {
            val delivered = mutableSetOf<String>()
            settledReplies.collect { if (delivered.add(it.id)) call.landedReply(it.id, it.text, it.at) }
        }
        if (ownerConnection != null) bindOwnerConnection(target, ownerConnection)
        if (ownerRuntimeRevision != null) bindOwnerRuntimeRevision(target, ownerRuntimeRevision)
        call.start(settings.language, settings.voice, settings.speed, opener)
        return call
    }
    fun ring(value: IncomingVoiceCall, acknowledge: suspend (String) -> Unit) {
        if (!seenRings.add(value.ringId)) return
        if (seenRings.size > 500) { val newest = seenRings.toList().takeLast(250); seenRings.clear(); seenRings.addAll(newest) }
        scope.launch { runCatching { acknowledge(value.ringId) } }
        val current = call.value
        // A live call stays in control; the root may show the new reason as a banner.
        if (current != null && current.state.value.phase in listOf("live", "connecting", "reconnecting")) return
        declineRing()
        mutableIncoming.value = value
        ringtone = runCatching { android.media.RingtoneManager.getRingtone(app, android.media.RingtoneManager.getDefaultUri(android.media.RingtoneManager.TYPE_RINGTONE)) }.getOrNull()
        runCatching { ringtone?.play() }
        ringTimeout = scope.launch { delay(30000); if (incoming.value?.ringId == value.ringId) declineRing() }
    }
    fun declineRing() {
        ringTimeout?.cancel(); ringTimeout = null
        runCatching { ringtone?.stop() }; ringtone = null; mutableIncoming.value = null
    }
    fun takeRing(): IncomingVoiceCall? = incoming.value?.also { declineRing() }
    fun minimize() { if (call.value != null) mutablePresentation.value = Presentation.MINIMIZED }
    fun expand() { if (call.value != null) mutablePresentation.value = Presentation.FULL }
    fun dismiss() {
        val call = call.value
        if (call != null && call.state.value.phase !in listOf("ended", "failed", "ready")) { minimize(); return }
        mutableCall.value = null; mutableTarget.value = null; mutablePresentation.value = Presentation.CLOSED
    }
    fun hangUp() { call.value?.hangUp() }
    fun records(target: VoiceCallTarget): List<VoiceCallHistory> = history.value.filter {
        it.connectionId == target.connectionId && it.botId == target.botId && it.threadId == target.threadId
    }
    /** Bind the exact Session captured by call HTTP callbacks, even if another home remains paired. */
    fun bindOwnerConnection(target: VoiceCallTarget, ownerConnection: StateFlow<Connection?>) {
        val ownedCall = call.value ?: return
        if (this.target.value != target) return
        observation?.cancel()
        observation = scope.launch {
            ownerConnection.first { it?.id != target.connectionId }
            if (mutableCall.value === ownedCall && mutableTarget.value == target) {
                ownedCall.hangUp()
                replies?.cancel(); replies = null
                dismiss()
            }
        }
    }
    /** A same-home re-pair also revokes the captured credentials and call consent. */
    fun bindOwnerRuntimeRevision(target: VoiceCallTarget, revision: StateFlow<Long>) {
        val ownedCall = call.value ?: return
        if (this.target.value != target) return
        val captured = revision.value
        revisionObservation?.cancel()
        revisionObservation = scope.launch {
            revision.first { it != captured }
            if (mutableCall.value === ownedCall && mutableTarget.value == target) {
                ownedCall.hangUp(); replies?.cancel(); replies = null; dismiss()
            }
        }
    }
    /** Feed paired home ids, including temporarily offline homes. Removal/re-pairing ends origin-bound audio. */
    fun reconcileConnectedHomes(pairedConnectionIds: Set<String>) {
        if (target.value?.connectionId?.let { it !in pairedConnectionIds } == true) {
            // Synchronously close the socket and microphone before dropping the global/minimized presentation.
            hangUp()
            replies?.cancel(); replies = null
            dismiss()
        }
        if (incoming.value?.target?.connectionId?.let { it !in pairedConnectionIds } == true) declineRing()
    }
    fun forget(connectionId: String) {
        if (target.value?.connectionId == connectionId) { hangUp(); dismiss() }
        mutableHistory.update { it.filterNot { record -> record.connectionId == connectionId } }
        preferences.edit().putString("history", json.encodeToString(history.value)).apply()
    }
    private fun settingsKey(target: VoiceCallTarget) = "settings.${target.connectionId}.${target.botId}"
    companion object {
        @Volatile private var instance: VoiceCallCenter? = null
        fun get(context: Context): VoiceCallCenter = instance ?: synchronized(this) {
            instance ?: VoiceCallCenter(context).also { instance = it }
        }
    }
}

/** Survives screen recreation and locking; audio remains local until an explicit send. */
object RecordingCenter {
    private var current: AudioRecorder? = null
    @Synchronized fun recorder(context: Context): AudioRecorder = current ?: AudioRecorder(context).also { current = it }
}

/** Ring metadata contains no credentials; microphone activation still requires the answer tap. */
data class IncomingVoiceCall(val ringId: String, val target: VoiceCallTarget, val reason: String, val receivedAt: Long = System.currentTimeMillis(), val runtimeIdentity: Any? = null) {
    fun canAnswer(runtime: Any?): Boolean = runtimeIdentity != null && runtimeIdentity === runtime
}
