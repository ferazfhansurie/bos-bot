package com.openmausbot.companion.audio

import android.Manifest
import android.app.Application
import android.os.Looper
import com.openmausbot.companion.core.Connection
import kotlinx.coroutines.flow.MutableStateFlow
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleRegistry
import androidx.lifecycle.ProcessLifecycleOwner
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.CompletableDeferred
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33], application = Application::class)
class VoiceCallOriginLifecycleTest {
    private fun pendingCall(): Triple<VoiceCallCenter, RealtimeAudioCall, VoiceCallTarget> {
        val app = ApplicationProvider.getApplicationContext<Application>()
        shadowOf(app).grantPermissions(Manifest.permission.RECORD_AUDIO)
        (ProcessLifecycleOwner.get().lifecycle as LifecycleRegistry).currentState = Lifecycle.State.STARTED
        val center = VoiceCallCenter.get(app)
        val target = VoiceCallTarget("original-pairing", "bot", "thread", "bos")
        val credential = CompletableDeferred<JsonObject>()
        val call = center.start(target, { _, _ -> credential.await() }, { _, _ -> null },
            { JsonObject(emptyMap()) }, { _, _ -> })
        assertEquals("connecting", call.state.value.phase)
        center.minimize()
        return Triple(center, call, target)
    }

    @Test fun removingOriginStopsMinimizedCallAndItsPendingDial() {
        val (center, call, _) = pendingCall()
        center.reconcileConnectedHomes(setOf("another-pairing"))
        assertEquals("ended", call.state.value.phase)
        assertNull(center.call.value)
        assertNull(center.target.value)
        assertEquals(VoiceCallCenter.Presentation.CLOSED, center.presentation.value)
    }

    @Test fun replacingCredentialsOnTheSameHomeEndsItsCapturedCall() {
        val (center, call, target) = pendingCall()
        val revision = MutableStateFlow(1L)
        center.bindOwnerRuntimeRevision(target, revision)
        revision.value = 2L
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals("ended", call.state.value.phase)
        assertNull(center.call.value)
        assertEquals(VoiceCallCenter.Presentation.CLOSED, center.presentation.value)
    }

    @Test fun unrelatedHomeRemovalAndTemporaryOfflineStateDoNotEndOriginCall() {
        val (center, call, target) = pendingCall()
        // The paired origin id remains in homesState even when its network status is offline.
        center.reconcileConnectedHomes(setOf(target.connectionId))
        assertSame(call, center.call.value)
        assertEquals("connecting", call.state.value.phase)
        assertEquals(VoiceCallCenter.Presentation.MINIMIZED, center.presentation.value)
        center.hangUp(); center.dismiss()
    }

    @Test fun replacingPairingUuidDeclinesOldRing() {
        val (center, call, target) = pendingCall()
        center.hangUp(); center.dismiss()
        center.ring(IncomingVoiceCall("ring", target, "need your input")) {}
        assertNotNull(center.incoming.value)
        center.reconcileConnectedHomes(setOf("replacement-pairing"))
        assertNull(center.incoming.value)
        assertEquals("ended", call.state.value.phase)
    }
    @Test fun switchingCapturedSessionStopsPendingMinimizedCallEvenWhenOriginRemainsPaired() {
        val (center, call, target) = pendingCall()
        val owner = MutableStateFlow<Connection?>(Connection(id = target.connectionId, name = "original", host = "127.0.0.1", port = 4317))
        center.bindOwnerConnection(target, owner)
        center.reconcileConnectedHomes(setOf(target.connectionId, "another-pairing"))
        assertSame(call, center.call.value)
        owner.value = Connection(id = "another-pairing", name = "another", host = "127.0.0.2", port = 4317)
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals("ended", call.state.value.phase)
        assertNull(center.call.value)
        assertEquals(VoiceCallCenter.Presentation.CLOSED, center.presentation.value)
    }

    @Test fun endpointChangesWithinSameCapturedPairingKeepCallAlive() {
        val (center, call, target) = pendingCall()
        val original = Connection(id = target.connectionId, name = "original", host = "127.0.0.1", port = 4317)
        val owner = MutableStateFlow<Connection?>(original)
        center.bindOwnerConnection(target, owner)
        owner.value = original.copy(host = "100.72.0.1")
        shadowOf(Looper.getMainLooper()).idle()
        assertSame(call, center.call.value)
        assertEquals("connecting", call.state.value.phase)
        center.hangUp(); center.dismiss()
    }
}
