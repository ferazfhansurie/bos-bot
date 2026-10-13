package com.openmausbot.companion.core

import kotlin.test.Test
import kotlin.test.assertNull
import kotlin.test.assertFalse
import kotlinx.serialization.encodeToString
import kotlinx.serialization.decodeFromString

class VoiceRingRuntimeTest {
    @Test fun wireDataCannotSupplyAnAuthenticatedRuntimeMarker() {
        val ring = CompanionJson.decodeFromString<VoiceRing>("""{"ringId":"id","botId":"bot","runtimeIdentity":"forged"}""")
        assertNull(ring.runtimeIdentity)
        val encoded = CompanionJson.encodeToString(ring.copy(runtimeIdentity = Any()))
        assertFalse(encoded.contains("runtimeIdentity"))
    }
}
