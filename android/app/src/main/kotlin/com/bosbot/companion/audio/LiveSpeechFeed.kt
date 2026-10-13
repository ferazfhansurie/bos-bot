package com.openmausbot.companion.audio

import android.content.Context
import android.content.Intent
import android.media.AudioFormat
import android.os.Build
import android.os.Bundle
import android.os.ParcelFileDescriptor
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel

/** API 33 supplied-audio recognition: capture and speech share PCM, never competing microphones. */
internal class LiveSpeechFeed(
    private val context: Context,
    private val onTranscript: (String) -> Unit,
    private val onUnavailable: (String) -> Unit,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var speech: SpeechRecognizer? = null
    private var read: ParcelFileDescriptor? = null
    private var write: ParcelFileDescriptor? = null
    private var writer: Job? = null
    private var rotation: Job? = null
    private var watchdog: Job? = null
    @Volatile private var queue: Channel<ByteArray>? = null
    private var committed = ""
    private var partial = ""
    private var active = false
    private var token = 0
    private var finalizing = false
    private var finished: (() -> Unit)? = null
    fun start() {
        if (Build.VERSION.SDK_INT < 33 || !SpeechRecognizer.isRecognitionAvailable(context)) {
            onUnavailable("Live transcription needs Android 13 and a compatible speech service. Audio is still saved.")
            return
        }
        active = true
        openSegment()
    }
    fun append(bytes: ByteArray, size: Int) {
        val feed = queue ?: return
        if (!feed.trySend(bytes.copyOf(size)).isSuccess) scope.launch {
            if (active) { onUnavailable("Speech transcription fell behind. Audio is still saved."); stopImmediately() }
        }
    }
    private fun openSegment() {
        if (!active) return
        val generation = ++token
        try {
            val descriptors = ParcelFileDescriptor.createPipe()
            read = descriptors[0]; write = descriptors[1]
            val channel = Channel<ByteArray>(96)
            queue = channel
            val output = ParcelFileDescriptor.AutoCloseOutputStream(descriptors[1])
            writer = scope.launch(Dispatchers.IO) {
                try { output.use { sink -> for (data in channel) sink.write(data) } }
                catch (_: Exception) { /* recognition may close its input at a normal segment boundary */ }
            }
            val recognizer = if (Build.VERSION.SDK_INT >= 31 && SpeechRecognizer.isOnDeviceRecognitionAvailable(context))
                SpeechRecognizer.createOnDeviceSpeechRecognizer(context) else SpeechRecognizer.createSpeechRecognizer(context)
            speech = recognizer
            recognizer.setRecognitionListener(object : RecognitionListener {
                override fun onReadyForSpeech(params: Bundle?) {}
                override fun onBeginningOfSpeech() {}
                override fun onRmsChanged(rmsdB: Float) {}
                override fun onBufferReceived(buffer: ByteArray?) {}
                override fun onEndOfSpeech() {}
                override fun onEvent(eventType: Int, params: Bundle?) {}
                override fun onPartialResults(results: Bundle?) {
                    if (generation != token) return
                    partial = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty()
                    onTranscript(join(committed, partial))
                }
                override fun onResults(results: Bundle?) {
                    if (generation != token) return
                    val result = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty()
                    committed = join(committed, result.ifEmpty { partial }); partial = ""
                    onTranscript(committed)
                    advance()
                }
                override fun onError(error: Int) {
                    if (generation != token) return
                    committed = join(committed, partial); partial = ""; onTranscript(committed)
                    if (error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT || error == SpeechRecognizer.ERROR_SERVER_DISCONNECTED) advance()
                    else {
                        onUnavailable("Live speech unavailable ($error). Audio is still saved.")
                        stopImmediately()
                    }
                }
            })
            val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
                .putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE, descriptors[0])
                .putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_CHANNEL_COUNT, 1)
                .putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_ENCODING, AudioFormat.ENCODING_PCM_16BIT)
                .putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_SAMPLING_RATE, PcmAudio.RATE)
            recognizer.startListening(intent)
            rotation = scope.launch {
                delay(45000)
                if (generation == token) {
                    queue = null; channel.close(); write?.close()
                    speech?.stopListening()
                    watchdog = scope.launch { delay(5000); if (generation == token) { committed = join(committed, partial); partial = ""; onTranscript(committed); advance() } }
                }
            }
        } catch (_: Exception) {
            onUnavailable("Live speech transcription unavailable. Audio is still saved.")
            stopImmediately()
        }
    }
    private fun advance() {
        closeSegment()
        if (finalizing || !active) { active = false; finish() }
        else scope.launch { delay(150); openSegment() }
    }
    fun stop(onFinished: () -> Unit) {
        finished = onFinished
        finalizing = true
        if (!active) { finish(); return }
        rotation?.cancel()
        queue?.close(); queue = null
        runCatching { write?.close() }
        runCatching { speech?.stopListening() }
        val generation = token
        watchdog = scope.launch {
            delay(5000)
            if (generation == token) { committed = join(committed, partial); partial = ""; onTranscript(committed); stopImmediately() }
        }
    }
    private fun finish() { finished?.also { finished = null; it() } }
    private fun closeSegment() {
        token++
        rotation?.cancel(); rotation = null; watchdog?.cancel(); watchdog = null
        queue?.close(); queue = null
        runCatching { read?.close() }; runCatching { write?.close() }; read = null; write = null
        writer?.cancel(); writer = null
        speech?.destroy(); speech = null
    }
    fun stopImmediately() {
        active = false
        committed = join(committed, partial); partial = ""; onTranscript(committed)
        closeSegment(); finish()
    }
    fun close() { stopImmediately(); scope.cancel() }
    private fun join(left: String, right: String) = listOf(left.trim(), right.trim()).filter(String::isNotEmpty).joinToString(" ")
}
