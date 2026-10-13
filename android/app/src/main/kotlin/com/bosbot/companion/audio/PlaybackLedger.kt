package com.openmausbot.companion.audio

/** Associates speaker playback positions with the actual item heard, including queued future items. */
internal class PlaybackLedger {
    data class Span(val id: String, val contentIndex: Int, val start: Long, val end: Long)
    data class Heard(val id: String, val contentIndex: Int, val milliseconds: Long)
    private val spans = mutableListOf<Span>()
    private var queued = 0L
    @Synchronized fun append(id: String, contentIndex: Int, frames: Int) {
        if (frames <= 0) return
        val last = spans.lastOrNull()
        if (last?.id == id && last.contentIndex == contentIndex) spans[spans.lastIndex] = last.copy(end = queued + frames)
        else spans.add(Span(id, contentIndex, queued, queued + frames))
        queued += frames
    }
    @Synchronized fun heard(playbackHead: Long): Heard? {
        val head = playbackHead.coerceIn(0, queued)
        val span = spans.firstOrNull { head < it.end } ?: spans.lastOrNull() ?: return null
        return Heard(span.id, span.contentIndex, (head - span.start).coerceAtLeast(0) * 1000 / PcmAudio.RATE)
    }
    @Synchronized fun clear() { spans.clear(); queued = 0 }
}
