package com.openmausbot.companion.audio

import org.junit.Test
import org.junit.Assert.*
import java.io.File
import java.io.RandomAccessFile
import kotlinx.serialization.json.*
import kotlinx.serialization.encodeToString

class NativeAudioTest {
    @Test fun savedWaveHeaderMatchesPersistedPcmAndDuration() {
        val file = File.createTempFile("recording", ".wav")
        try {
            RandomAccessFile(file, "rw").use {
                PcmAudio.waveHeader(it, 0)
                it.seek(44); it.write(ByteArray(48000))
                PcmAudio.waveHeader(it, 48000)
            }
            val bytes = file.readBytes()
            assertEquals("RIFF", String(bytes.copyOfRange(0, 4)))
            assertEquals("WAVE", String(bytes.copyOfRange(8, 12)))
            fun little(at: Int) = (0..3).sumOf { (bytes[at + it].toLong() and 255) shl (it * 8) }
            assertEquals(48036L, little(4)); assertEquals(24000L, little(24)); assertEquals(48000L, little(40))
            assertEquals(1L, PcmAudio.duration(48000))
        } finally { file.delete() }
    }
    @Test fun microphoneLevelsDecodeSignedLittleEndianSamples() {
        assertEquals(0f, PcmAudio.level(byteArrayOf()), 0f)
        assertEquals(1f, PcmAudio.level(byteArrayOf(0, -128)), 0.00001f)
        assertEquals(0.5f, PcmAudio.level(byteArrayOf(0, 64)), 0.00001f)
    }
    @Test fun onlyOfficialEndpointReceivesMicrophoneAndSecretNeverEntersUrl() {
        assertEquals("api.x.ai", voiceSocketUrl("wss://api.x.ai/v1/realtime", "grok voice").host)
        val rejected = listOf("wss://evil.test/v1/realtime", "https://api.x.ai/v1/realtime", "wss://api.x.ai.evil.test/", "wss://user@api.x.ai/", "wss://api.x.ai/?token=secret", "wss://api.x.ai:444/")
        rejected.forEach { value -> assertThrows(IllegalArgumentException::class.java) { voiceSocketUrl(value, "grok") } }
    }
    @Test fun interruptionTruncatesHeardItemInsteadOfLastQueuedItem() {
        val ledger = PlaybackLedger()
        ledger.append("first", 0, 48000)
        ledger.append("second", 1, 24000)
        assertEquals(PlaybackLedger.Heard("first", 0, 1000), ledger.heard(24000))
        assertEquals(PlaybackLedger.Heard("second", 1, 500), ledger.heard(60000))
        ledger.clear(); assertNull(ledger.heard(0))
    }
    @Test fun reconnectBackoffIsImmediateThenBounded() {
        assertEquals(0L, reconnectDelay(1))
        assertEquals(1000L, reconnectDelay(2))
        assertEquals(1200L, reconnectDelay(3))
        assertEquals(10000L, reconnectDelay(100))
    }
    @Test fun serverVoiceOptionsNormalizeInvalidSavedPreferences() {
        val options = buildJsonObject {
            put("voices", JsonArray(listOf(JsonPrimitive("ara"), JsonPrimitive("liora"))))
            put("speeds", JsonArray(listOf(JsonPrimitive(0.75), JsonPrimitive(1.25))))
            put("languages", JsonArray(listOf(JsonPrimitive("auto"), JsonPrimitive("ms"))))
        }
        assertEquals(VoiceSettings("liora", 1.25, "auto"), VoiceSettings("missing", 1.2, "missing").normalized(options))
        assertEquals(VoiceSettings("liora", 1.0, "auto"), VoiceSettings("missing", 1.01, "missing").normalized(null))
    }
    @Test fun persistentCallTranscriptRoundTripsWithExplicitConnectionScope() {
        val record = VoiceCallHistory("call", "computer-one", "bot", "thread", 1234, 32,
            listOf(RealtimeAudioCall.Line("item", "you", "my exact words", true)))
        val restored = Json.decodeFromString<VoiceCallHistory>(Json.encodeToString(record))
        assertEquals(record, restored)
        assertEquals("computer-one", restored.connectionId)
        assertEquals("my exact words", restored.transcript.single().text)
        assertTrue(restored.transcript.single().final)
    }
}
