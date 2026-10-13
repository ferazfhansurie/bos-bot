package com.openmausbot.companion.audio

import android.app.Activity
import android.content.Context
import android.content.Intent
import androidx.test.core.app.ApplicationProvider
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleRegistry
import androidx.lifecycle.ProcessLifecycleOwner
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.Shadows.shadowOf

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class MicrophoneServiceLifecycleTest {
    @Test fun retiredServiceCannotStopRapidReplacementMicrophone() = assertRapidReplacement("first", "second")
    @Test fun retiredServiceCannotStopSameRecorderRapidRestart() = assertRapidReplacement("recorder", "recorder")

    private fun assertRapidReplacement(firstOwner: String, nextOwner: String) {
        val activity = Robolectric.buildActivity(Activity::class.java).setup()
        (ProcessLifecycleOwner.get().lifecycle as LifecycleRegistry).currentState = Lifecycle.State.STARTED
        val context = ApplicationProvider.getApplicationContext<Context>()
        var firstStops = 0
        var secondStops = 0
        MicrophoneService.acquire(context, firstOwner) { firstStops++ }
        val firstIntent = shadowOf(context as android.app.Application).nextStartedService!!
        val old = Robolectric.buildService(MicrophoneService::class.java, firstIntent).create().startCommand(0, 1)
        MicrophoneService.release(context, firstOwner)
        MicrophoneService.acquire(context, nextOwner) { secondStops++ }
        val secondIntent = shadowOf(context).nextStartedService!!
        assertNotEquals(firstIntent.getLongExtra("bos.audio.generation", -1), secondIntent.getLongExtra("bos.audio.generation", -1))
        old.get().onStartCommand(secondIntent, 0, 2) // delayed replacement intent must not attach to a retiring instance
        old.destroy()
        assertEquals(0, firstStops)
        assertEquals("A retired service must not stop a replacement lease", 0, secondStops)
        // A second owner would be refused if the replacement still owns its lease.
        assertThrows(IllegalStateException::class.java) { MicrophoneService.acquire(context, "third") {} }
        val replacement = Robolectric.buildService(MicrophoneService::class.java, secondIntent).create().startCommand(0, 2)
        replacement.destroy()
        assertEquals("Actual current service destruction must stop its microphone", 1, secondStops)
        activity.pause().stop().destroy()
    }

    @Test fun explicitNotificationStopStillStopsCurrentReplacement() {
        val activity = Robolectric.buildActivity(Activity::class.java).setup()
        (ProcessLifecycleOwner.get().lifecycle as LifecycleRegistry).currentState = Lifecycle.State.STARTED
        val context = ApplicationProvider.getApplicationContext<android.app.Application>()
        var stopped = 0
        MicrophoneService.acquire(context, "active") { stopped++ }
        val intent = shadowOf(context).nextStartedService!!
        val service = Robolectric.buildService(MicrophoneService::class.java, intent).create().startCommand(0, 1)
        service.get().onStartCommand(Intent(context, MicrophoneService::class.java).setAction("bos.audio.stop"), 0, 2)
        assertEquals(1, stopped)
        service.destroy()
        assertEquals("Destroy cannot double-stop a lease already stopped by the user", 1, stopped)
        activity.pause().stop().destroy()
    }
}
