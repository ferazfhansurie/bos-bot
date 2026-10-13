package com.openmausbot.companion.ui

import androidx.activity.ComponentActivity
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.MotionDurationScale
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextReplacement
import com.openmausbot.companion.core.*
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
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.test.assertFalse
import kotlin.test.assertTrue

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
@OptIn(ExperimentalTestApi::class)
class AgentProfileParityWiringTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>(effectContext = object : MotionDurationScale { override val scaleFactor = 0f })
    private val server = MockWebServer().apply {
        dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest) = MockResponse().setBody(when (request.path) {
                "/api/config" -> "{}"
                "/api/instances" -> "{\"instances\":[]}"
                "/api/tts/voices" -> "{\"voices\":[]}"
                "/.well-known/openmausbot/environment" -> "{\"environmentId\":\"test\",\"label\":\"fixture\",\"platform\":\"darwin\"}"
                else -> "{}"
            })
        }
        start()
    }
    @After fun closeServer() { server.shutdown() }
    private val dismissed = AtomicBoolean(false)
    private fun mount(clientOnly: Boolean = false) {
        val bot = Bot("bot", "thread", "bot", "builder", "builds", true, "green", false, ModelSelection("i1", "m1"), 1.0, avatarCrop = AvatarCrop.CIRCLE)
        val scene = WiringScene(Connection(id = "profile-fixture", name = "Fixture", host = "127.0.0.1", port = server.port, serverEnvironmentId = if (clientOnly) "test" else null, serverScopes = if (clientOnly) listOf("client") else null))
        compose.setContent { CompositionLocalProvider(LocalCompanion provides scene.environment) { CompanionTheme(darkTheme = false) { AgentProfileSheet(bot, { dismissed.set(true) }, {}) } } }
        compose.waitUntil(5_000) { scene.session.connection.value != null }
        compose.waitForIdle()
    }
    @Test fun `dirty identity cannot be dismissed silently`() {
        mount()
        compose.onNodeWithText("Name").performScrollTo().performTextReplacement("changed")
        compose.onNodeWithText("Done").performScrollTo().performClick()
        compose.onNodeWithText("Save your changes?").assertExists()
        assertFalse(dismissed.get())
        compose.onNodeWithText("Keep editing").performClick()
        assertFalse(dismissed.get())
        compose.onNodeWithText("Done").performClick()
        compose.onNodeWithText("Discard changes").performClick()
        assertTrue(dismissed.get())
    }
    @Test fun `client only settings hide model and image generation`() {
        mount(clientOnly = true)
        compose.onNodeWithText("MODEL").assertDoesNotExist()
        compose.onNodeWithText("GENERATE AN AVATAR").assertDoesNotExist()
        compose.onNodeWithText("IDENTITY").performScrollTo().assertExists()
    }
}
