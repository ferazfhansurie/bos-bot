package com.openmausbot.companion.audio

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import androidx.core.content.ContextCompat
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import java.io.File
import java.io.RandomAccessFile
import java.util.UUID

/** Capture owns the microphone; recognition consumes the saved PCM, never a second microphone. */
class AudioRecorder(context: Context) {
    data class State(val recording: Boolean = false, val finishing: Boolean = false,
        val file: File? = null, val transcript: String = "", val seconds: Long = 0,
        val level: Float = 0f, val error: String? = null, val meetingMode: Boolean = false)
    private val app = context.applicationContext
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val mutable = MutableStateFlow(State())
    val state = mutable.asStateFlow()
    private var microphone: AudioRecord? = null
    private var capture: Job? = null
    private var recognizer: SpeechRecognizer? = null
    private var descriptor: ParcelFileDescriptor? = null
    private var speechTimeout: Job? = null
    private var generation = 0
    private var raw: File? = null
    private var closed = false
    private var liveSpeech: LiveSpeechFeed? = null
    private val serviceOwner = "recording-${UUID.randomUUID()}"
    @Volatile private var running = false
    init {
        androidx.lifecycle.ProcessLifecycleOwner.get().lifecycle.addObserver(object : androidx.lifecycle.DefaultLifecycleObserver {
            override fun onStop(owner: androidx.lifecycle.LifecycleOwner) { if (!state.value.meetingMode) stop() }
        })
        // Repair a process-killed recording from its actual persisted PCM length.
        File(app.filesDir, "recordings").listFiles()?.filter { it.extension == "wav" && it.length() >= 44 }?.forEach { file ->
            runCatching { RandomAccessFile(file, "rw").use { PcmAudio.waveHeader(it, file.length() - 44) } }
        }
    }

    fun setMeetingMode(enabled: Boolean) { mutable.update { it.copy(meetingMode = enabled) } }
    fun start() {
        if (closed || state.value.recording || state.value.finishing) return
        if (ContextCompat.checkSelfPermission(app, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            mutable.value = state.value.copy(error = "Microphone permission is required")
            return
        }
        val directory = File(app.filesDir, "recordings").apply { mkdirs() }
        val name = "recording-${UUID.randomUUID()}"
        val file = File(directory, "$name.wav")
        raw = File(directory, "$name.pcm")
        val minimum = AudioRecord.getMinBufferSize(PcmAudio.RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        if (minimum <= 0) { mutable.value = State(error = "This microphone cannot record at 24 kHz"); return }
        try {
            MicrophoneService.acquire(app, serviceOwner) { stop() }
            val mic = AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, PcmAudio.RATE,
                AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, maxOf(minimum * 2, 8192))
            microphone = mic
            check(mic.state == AudioRecord.STATE_INITIALIZED) { "Microphone did not initialize" }
            mic.startRecording()
            check(mic.recordingState == AudioRecord.RECORDSTATE_RECORDING) { "Microphone did not start" }
            running = true
            mutable.value = State(recording = true, file = file, meetingMode = state.value.meetingMode)
            liveSpeech?.close()
            liveSpeech = LiveSpeechFeed(app,
                onTranscript = { text -> mutable.update { it.copy(transcript = text) } },
                onUnavailable = { error -> mutable.update { it.copy(error = error) } },
            ).also { it.start() }
            capture = scope.launch(Dispatchers.IO) {
                var size = 0L
                try {
                    RandomAccessFile(file, "rw").use { wave ->
                        PcmAudio.waveHeader(wave, 0)
                        raw!!.outputStream().use { pcm ->
                            val buffer = ByteArray(4096)
                            try {
                                while (running) {
                                    val count = mic.read(buffer, 0, buffer.size)
                                    if (!running) break
                                    check(count >= 0) { "Microphone capture failed ($count)" }
                                    if (count == 0) continue
                                    wave.write(buffer, 0, count); pcm.write(buffer, 0, count); size += count
                                    liveSpeech?.append(buffer, count)
                                    mutable.update { it.copy(seconds = PcmAudio.duration(size), level = PcmAudio.level(buffer, count)) }
                                }
                            } finally { PcmAudio.waveHeader(wave, size); wave.fd.sync() }
                        }
                    }
                } catch (_: Exception) {
                    mutable.value = mutable.value.copy(error = "Audio capture stopped unexpectedly; saved audio remains available")
                } finally {
                    running = false
                    runCatching { mic.stop() }; mic.release(); microphone = null
                    withContext(Dispatchers.Main) {
                        mutable.value = mutable.value.copy(recording = false, level = 0f)
                        MicrophoneService.release(app, serviceOwner)
                        if (!mutable.value.finishing && !closed) liveSpeech?.stop {
                            liveSpeech?.close(); liveSpeech = null; finishRecognition(null)
                        }
                    }
                }
            }
        } catch (_: Exception) {
            microphone?.release(); microphone = null
            MicrophoneService.release(app, serviceOwner)
            mutable.value = State(error = "Unable to open microphone")
        }
    }

    /** Stopping preserves audio even if recognition fails or the screen is dismissed. */
    fun stop(transcribe: Boolean = true) {
        if (!state.value.recording) return
        running = false
        mutable.value = mutable.value.copy(recording = false, finishing = true, level = 0f)
        runCatching { microphone?.stop() }
        scope.launch {
            capture?.join()
            if (transcribe && !closed && liveSpeech != null) {
                liveSpeech?.stop {
                    liveSpeech?.close(); liveSpeech = null
                    finishRecognition(null)
                    raw?.delete(); raw = null
                }
            } else {
                raw?.delete(); raw = null
                mutable.value = mutable.value.copy(finishing = false)
            }
        }
    }
    private fun transcribeSavedAudio() {
        if (Build.VERSION.SDK_INT < 33 || !SpeechRecognizer.isRecognitionAvailable(app)) {
            mutable.value = mutable.value.copy(finishing = false, error = "Audio saved. Transcription of recorded audio requires Android 13 and a compatible speech service")
            raw?.delete(); return
        }
        val source = raw ?: return
        val token = ++generation
        try {
            descriptor = ParcelFileDescriptor.open(source, ParcelFileDescriptor.MODE_READ_ONLY)
            val speech = if (SpeechRecognizer.isOnDeviceRecognitionAvailable(app)) SpeechRecognizer.createOnDeviceSpeechRecognizer(app)
                else SpeechRecognizer.createSpeechRecognizer(app)
            recognizer = speech
            speech.setRecognitionListener(object : RecognitionListener {
                override fun onReadyForSpeech(params: Bundle?) {}
                override fun onBeginningOfSpeech() {}
                override fun onRmsChanged(rmsdB: Float) {}
                override fun onBufferReceived(buffer: ByteArray?) {}
                override fun onEndOfSpeech() {}
                override fun onEvent(eventType: Int, params: Bundle?) {}
                override fun onPartialResults(results: Bundle?) {
                    if (generation == token) mutable.value = mutable.value.copy(transcript = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty())
                }
                override fun onResults(results: Bundle?) {
                    if (generation != token) return
                    mutable.value = mutable.value.copy(transcript = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty())
                    finishRecognition(null)
                }
                override fun onError(error: Int) {
                    if (generation == token) finishRecognition("Audio saved. Speech transcription unavailable ($error)")
                }
            })
            val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
                .putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE, descriptor)
                .putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_CHANNEL_COUNT, 1)
                .putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_ENCODING, AudioFormat.ENCODING_PCM_16BIT)
                .putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_SAMPLING_RATE, PcmAudio.RATE)
            speech.startListening(intent)
            speechTimeout = scope.launch { delay(120000); if (generation == token) finishRecognition("Audio saved. Transcription timed out") }
        } catch (_: Exception) { finishRecognition("Audio saved. Speech transcription unavailable") }
    }
    private fun finishRecognition(error: String?) {
        generation++
        speechTimeout?.cancel(); speechTimeout = null
        recognizer?.destroy(); recognizer = null
        descriptor?.close(); descriptor = null
        if (!running && capture?.isActive != true) { raw?.delete(); raw = null }
        state.value.file?.let { file ->
            if (state.value.transcript.isNotEmpty()) runCatching { File(file.parentFile, file.nameWithoutExtension + ".txt").writeText(state.value.transcript) }
        }
        mutable.value = mutable.value.copy(finishing = false, error = error ?: mutable.value.error)
    }
    fun close() {
        closed = true
        liveSpeech?.close(); liveSpeech = null
        stop(transcribe = false)
        finishRecognition(null)
        // Capture is deliberately not cancelled before its WAV header is finalized.
        scope.launch { capture?.join(); scope.cancel() }
    }
    fun recordings(): List<File> = File(app.filesDir, "recordings").listFiles()
        ?.filter { it.extension == "wav" && it.length() > 44 }?.sortedByDescending(File::lastModified).orEmpty()
}
