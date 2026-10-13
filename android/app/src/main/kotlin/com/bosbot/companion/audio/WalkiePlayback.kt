package com.openmausbot.companion.audio

import android.content.Context
import android.media.AudioAttributes
import android.media.MediaDataSource
import android.media.MediaPlayer
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import java.util.Locale
import java.util.UUID
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout

/** Screen-owned speech playback; no recorder, permanent observer, or audio file. */
class WalkiePlayback(context: Context) : AutoCloseable {
    private val ready = CompletableDeferred<Boolean>()
    private val tts = TextToSpeech(context.applicationContext) { ready.complete(it == TextToSpeech.SUCCESS) }
    private val focus = AudioFocusGate(context.applicationContext)
    private var player: MediaPlayer? = null
    private var completion: CompletableDeferred<Unit>? = null

    fun stop() {
        completion?.cancel(); completion = null
        player?.let { runCatching { it.stop() }; it.release() }; player = null
        tts.stop(); focus.abandon()
    }
    suspend fun play(data: ByteArray) = withContext(Dispatchers.Main.immediate) {
        stop()
        val done = CompletableDeferred<Unit>()
        completion = done
        check(focus.request { stop() }) { "Another app is using audio." }
        val next = MediaPlayer()
        player = next
        try {
            next.setAudioAttributes(AudioAttributes.Builder().setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).setUsage(AudioAttributes.USAGE_MEDIA).build())
            next.setDataSource(object : MediaDataSource() {
                override fun getSize() = data.size.toLong()
                override fun readAt(position: Long, buffer: ByteArray, offset: Int, size: Int): Int {
                    if (position < 0 || position >= data.size) return -1
                    val count = minOf(size, data.size - position.toInt())
                    data.copyInto(buffer, offset, position.toInt(), position.toInt() + count)
                    return count
                }
                override fun close() = Unit
            })
            next.setOnPreparedListener { it.start() }
            next.setOnCompletionListener { done.complete(Unit) }
            next.setOnErrorListener { _, _, _ -> done.completeExceptionally(IllegalStateException("Couldn't play this reply.")); true }
            next.prepareAsync()
            done.await()
        } finally { if (player === next) { next.release(); player = null }; completion = null; focus.abandon() }
    }
    suspend fun speak(text: String) = withContext(Dispatchers.Main.immediate) {
        stop()
        check(withTimeout(5_000) { ready.await() }) { "The phone's speech voice is unavailable." }
        val done = CompletableDeferred<Unit>()
        completion = done
        val id = UUID.randomUUID().toString()
        check(focus.request { stop() }) { "Another app is using audio." }
        tts.language = Locale.getDefault()
        tts.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String?) = Unit
            override fun onDone(utteranceId: String?) { if (utteranceId == id) done.complete(Unit) }
            @Deprecated("Platform callback")
            override fun onError(utteranceId: String?) { if (utteranceId == id) done.completeExceptionally(IllegalStateException("Couldn't read this reply aloud.")) }
        })
        try {
            check(tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, id) != TextToSpeech.ERROR) { "Couldn't read this reply aloud." }
            done.await()
        } finally { completion = null; focus.abandon() }
    }
    override fun close() { stop(); tts.shutdown() }
}
