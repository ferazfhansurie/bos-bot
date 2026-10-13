package com.openmausbot.companion.audio

import java.io.RandomAccessFile
import kotlin.math.sqrt

/** Shared wire/file format: mono little-endian PCM16. */
object PcmAudio {
    const val RATE = 24000
    fun level(bytes: ByteArray, count: Int = bytes.size): Float {
        var sum = 0.0
        val samples = count / 2
        for (i in 0 until samples) {
            val value = ((bytes[i * 2].toInt() and 255) or (bytes[i * 2 + 1].toInt() shl 8)).toShort() / 32768.0
            sum += value * value
        }
        return if (samples == 0) 0f else sqrt(sum / samples).toFloat()
    }
    fun waveHeader(file: RandomAccessFile, bytes: Long, sampleRate: Int = RATE) {
        require(bytes in 0..(0xffffffffL - 36)) { "Recording exceeds WAV size limit" }
        fun int(value: Long) { repeat(4) { file.write((value shr (8 * it)).toInt() and 255) } }
        fun short(value: Int) { file.write(value and 255); file.write(value shr 8 and 255) }
        file.seek(0)
        file.writeBytes("RIFF"); int(bytes + 36); file.writeBytes("WAVEfmt "); int(16)
        short(1); short(1); int(sampleRate.toLong()); int(sampleRate.toLong() * 2)
        short(2); short(16); file.writeBytes("data"); int(bytes)
    }
    fun duration(bytes: Long, sampleRate: Int = RATE) = bytes / (sampleRate * 2L)
}
