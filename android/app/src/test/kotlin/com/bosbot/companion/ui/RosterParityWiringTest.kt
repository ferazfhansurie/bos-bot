package com.openmausbot.companion.ui

import androidx.activity.ComponentActivity
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.MotionDurationScale
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import com.openmausbot.companion.core.*
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.flow
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
@OptIn(ExperimentalTestApi::class)
class RosterParityWiringTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>(effectContext = object : MotionDurationScale { override val scaleFactor = 0f })
    private val server = MockWebServer().apply { dispatcher = object : Dispatcher() { override fun dispatch(request: RecordedRequest) = if (request.path == "/.well-known/openmausbot/environment") MockResponse().setBody("{\"environmentId\":\"test\",\"label\":\"fixture\"}") else MockResponse().setResponseCode(404) }; start() }
    @After fun closeServer() { server.shutdown() }
    private fun mount(clientOnly: Boolean = false) {
        val bot = Bot("roster-bot", "roster-thread", "Fixture bot", "builder", "builds", true, "green", false, ModelSelection("i1", "m1"), 1.0,
            tasks = listOf(BotTask("roster-thread", "First thread", 1.0)))
        val scene = WiringScene(Connection(id = "roster-${System.nanoTime()}", name = "Fixture computer", host = "127.0.0.1", port = server.port, serverEnvironmentId = if (clientOnly) "test" else null, serverScopes = if (clientOnly) listOf("client") else null), fleet = Fleet(listOf(bot), emptyList())) { flow { emit(StreamFrame(Frame.Hello(cursor = "fixture:1", resumed = false), 1)); awaitCancellation() } }
        compose.setContent { CompositionLocalProvider(LocalCompanion provides scene.environment) { CompanionTheme(darkTheme = false) { RosterScreen(CompanionNavigator()) } } }
        compose.runOnIdle { scene.session.connect() }
        compose.waitUntil(5_000) { compose.onAllNodesWithText("Fixture bot").fetchSemanticsNodes().isNotEmpty() }
        compose.waitForIdle()
        compose.onNodeWithText("Fixture bot").assertExists()
    }
    @Test fun `normal rows have no legacy thread tree and pinning switches to a tile`() {
        mount()
        compose.onNodeWithText("Threads 1").assertDoesNotExist()
        compose.onNodeWithText("Threads").assertDoesNotExist()
        compose.onNodeWithText("Fixture bot").performTouchInput { longClick(center) }
        compose.onNodeWithText("Pin chat").performClick()
        compose.onNodeWithText("Fixture bot").assertExists()
        compose.onNodeWithText("Fixture bot").performTouchInput { longClick(center) }
        compose.onNodeWithText("Unpin chat").assertExists()
        compose.onNodeWithText("Unpin chat").performClick()
        compose.onNodeWithText("No messages yet").assertExists()
    }
    @Test fun `client scope hides owner creation and profile still reaches settings`() {
        mount(clientOnly = true)
        compose.onAllNodesWithContentDescription("Create").assertCountEquals(0)
        compose.onNodeWithContentDescription("Walkie").assertExists()
        compose.onNodeWithContentDescription("Your profile and settings").performClick()
        compose.onNodeWithText("Your profile").assertExists()
        compose.onNodeWithText("Settings & computers").assertExists()
        compose.onNodeWithText("Change profile photo").assertExists()
    }
}
