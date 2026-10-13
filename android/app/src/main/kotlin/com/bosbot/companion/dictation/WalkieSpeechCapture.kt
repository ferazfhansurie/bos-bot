package com.openmausbot.companion.dictation

import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import java.util.Locale
import com.openmausbot.companion.audio.MicrophoneService
import java.util.UUID
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

/** Stops audio at release and keeps a 1200ms grace period for the final transcript. */
class WalkieSpeechCapture(private val context: Context) {
    data class State(val phase: String = "idle", val text: String = "", val error: String? = null)
    private val mutable = MutableStateFlow(State())
    val state = mutable.asStateFlow()
    private val handler = Handler(Looper.getMainLooper())
    private val focus = DictationAudioFocusGate(context)
    private var recognizer: SpeechRecognizer? = null
    private var generation = 0
    private val leaseOwner = "walkie-${UUID.randomUUID()}"
    private var hasLease = false

    fun start() {
        cancel()
        val gen = generation
        if (!SpeechRecognizer.isRecognitionAvailable(context)) {
            mutable.value = State(error = "Speech recognition is unavailable on this phone.")
            return
        }
        mutable.value = State(phase = "listening")
        try {
            MicrophoneService.acquire(context, leaseOwner) {
                handler.post { if (generation == gen) { cancel(); mutable.value = State(error = "The microphone was stopped.") } }
            }
            hasLease = true
            if (!focus.request { handler.post { if (gen == generation) cancel() } }) {
                generation++; cleanup()
                mutable.value = State(error = "The microphone is being used by another app.")
                return
            }
            val engine = if (Build.VERSION.SDK_INT >= 31 && SpeechRecognizer.isOnDeviceRecognitionAvailable(context)) {
                runCatching { SpeechRecognizer.createOnDeviceSpeechRecognizer(context) }.getOrElse { SpeechRecognizer.createSpeechRecognizer(context) }
            } else SpeechRecognizer.createSpeechRecognizer(context)
            recognizer = engine
            engine.setRecognitionListener(object : RecognitionListener {
                override fun onReadyForSpeech(params: Bundle?) = Unit
                override fun onBeginningOfSpeech() = Unit
                override fun onRmsChanged(rmsdB: Float) = Unit
                override fun onBufferReceived(buffer: ByteArray?) = Unit
                override fun onEndOfSpeech() = Unit
                override fun onEvent(eventType: Int, params: Bundle?) = Unit
                override fun onPartialResults(results: Bundle?) {
                    if (generation == gen) text(results)?.let { mutable.value = mutable.value.copy(text = it) }
                }
                override fun onResults(results: Bundle?) {
                    if (generation != gen) return
                    text(results)?.let { mutable.value = mutable.value.copy(text = it) }
                    finish(gen)
                }
                override fun onError(error: Int) {
                    if (generation != gen) return
                    if (mutable.value.text.isNotBlank()) finish(gen)
                    else {
                        val message = if (error == SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS) "Walkie needs microphone access."
                            else "Didn't catch that. Hold the button while you speak, then release."
                        generation++; cleanup(); mutable.value = State(error = message)
                    }
                }
            })
            engine.startListening(Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault().toLanguageTag())
                putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
                putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
            })
        } catch (error: Exception) { generation++; cleanup(); mutable.value = State(error = error.message ?: "Couldn't start speech recognition.") }
    }

    fun release() {
        if (mutable.value.phase != "listening") return
        val gen = generation
        mutable.value = mutable.value.copy(phase = "transcribing")
        runCatching { recognizer?.stopListening() }
        handler.postDelayed({ if (generation == gen && mutable.value.phase == "transcribing") finish(gen) }, 1200)
    }
    private fun finish(gen: Int) {
        if (generation != gen) return
        val words = mutable.value.text.trim()
        generation++
        cleanup()
        mutable.value = if (words.isEmpty()) State(error = "Didn't catch that. Hold the button while you speak, then release.")
            else State(phase = "review", text = words)
    }
    fun cancel() { generation++; cleanup(); mutable.value = State() }
    private fun cleanup() { if (hasLease) { hasLease = false; MicrophoneService.release(context, leaseOwner) }; val old = recognizer; recognizer = null; runCatching { old?.cancel() }; runCatching { old?.destroy() }; focus.abandon() }
    private fun text(bundle: Bundle?): String? = bundle?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.takeIf(String::isNotBlank)
}
