package com.openmausbot.companion.ui

import android.graphics.Bitmap
import android.util.Base64
import androidx.activity.ComponentActivity
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.click
import com.openmausbot.companion.core.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.onCompletion
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.ByteArrayOutputStream
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.test.assertEquals
import kotlin.test.assertTrue

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class BrowserLiveScreenTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    @Test fun `frame is acknowledged before explicit control and tap carries its sequence`() {
        val events = Channel<BrowserViewerEvent>(Channel.UNLIMITED)
        val actions = CopyOnWriteArrayList<Pair<String, BrowserViewerAction>>()
        val cancelled = AtomicBoolean(false)
        var visible by mutableStateOf(true)
        val bytes = ByteArrayOutputStream().also { Bitmap.createBitmap(2, 2, Bitmap.Config.ARGB_8888).compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
        events.trySend(BrowserViewerEvent("ready", BrowserViewerPayload(viewerId = "viewer-1")))
        events.trySend(BrowserViewerEvent("frame", BrowserViewerPayload(seq = 9, data = Base64.encodeToString(bytes, Base64.NO_WRAP), metadata = BrowserFrameMetadata(2, 2))))
        val environment = WiringScene().environment
        compose.setContent { CompositionLocalProvider(LocalCompanion provides environment) { if (visible) CompanionTheme(darkTheme = false) { BrowserLiveScreen("bot", "c1", { events.receiveAsFlow().onCompletion { cancelled.set(true) } }, { viewer, action -> actions += viewer to action }, {}, {}) } } }
        compose.waitUntil(5_000) { actions.isNotEmpty() }
        assertEquals(listOf("viewer-1" to BrowserViewerAction.Acknowledge(9)), actions.toList())
        compose.onNodeWithText("take control").performClick()
        compose.waitUntil(5_000) { actions.any { it.second == BrowserViewerAction.Take } }
        events.trySend(BrowserViewerEvent("control", BrowserViewerPayload(controlling = true, held = true)))
        compose.waitUntil(5_000) { compose.onAllNodes(androidx.compose.ui.test.hasText("your control")).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithContentDescription("Live browser page").performTouchInput { click(center) }
        compose.waitUntil(5_000) { actions.any { it.second is BrowserViewerAction.Tap } }
        val tap = actions.last().second as BrowserViewerAction.Tap
        assertEquals(9, tap.seq)
        assertTrue(tap.x in 0.0..2.0 && tap.y in 0.0..2.0)
        compose.runOnIdle { visible = false }
        compose.waitForIdle()
        compose.waitUntil(5_000) { cancelled.get() }
        assertEquals(1, actions.count { it.second == BrowserViewerAction.Take })
    }
}
