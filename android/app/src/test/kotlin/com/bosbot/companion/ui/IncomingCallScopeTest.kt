package com.openmausbot.companion.ui

import com.openmausbot.companion.audio.IncomingVoiceCall
import com.openmausbot.companion.audio.VoiceCallTarget
import org.junit.Test
import org.junit.Assert.*

class IncomingCallScopeTest {
    @Test fun sameHomeRePairCannotAnswerThePreviousAccountsRing() {
        val original = Any(); val replacement = Any()
        val ring = IncomingVoiceCall("ring", VoiceCallTarget("home", "bot", "thread", "bos"), "reason", runtimeIdentity = original)
        val destination = Destination.VoiceCall(ring.target, consentRuntimeIdentity = ring.runtimeIdentity)
        assertSame(original, destination.consentRuntimeIdentity)
        assertNotSame(replacement, destination.consentRuntimeIdentity)
        assertTrue(ring.canAnswer(original)); assertFalse(ring.canAnswer(replacement)); assertFalse(ring.canAnswer(null))
    }
}
