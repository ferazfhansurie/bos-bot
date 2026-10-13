package com.openmausbot.companion.ui

import androidx.activity.ComponentActivity
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import com.openmausbot.companion.core.Connection
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
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.test.assertTrue

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SettingsParityWiringTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val writes = CopyOnWriteArrayList<String>()
    private var settlement = 3
    private val server = MockWebServer().apply {
        dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when(request.path) {
                "/api/provider-usage" -> MockResponse().setBody("""{"accounts":[{"instanceId":"i1","provider":"claude","account":"test","fiveHour":{"usedPercent":25},"sevenDay":{"usedPercent":56},"status":"ok"}]}""")
                "/api/config" -> {
                    if (request.method == "PATCH") { writes += request.body.readUtf8(); settlement = 1 }
                    MockResponse().setBody("""{"threads":{"autoSettleDays":$settlement,"maxConcurrentPerBot":5}}""")
                }
                else -> MockResponse().setResponseCode(404)
            }
        }
        start()
    }
    @After fun closeServer() { server.shutdown() }
    private fun mount() {
        val scene = WiringScene(Connection(id = "settings-test", name = "Fixture computer", host = "127.0.0.1", port = server.port))
        compose.setContent { CompositionLocalProvider(LocalCompanion provides scene.environment) { CompanionTheme(darkTheme = false) { SettingsScreen(onBack = {}, onOpenRoutines = {}) } } }
        compose.waitUntil(5_000) { scene.session.connection.value != null }
        compose.waitForIdle()
    }
    @Test fun `subscription limits navigation renders the server values`() {
        mount()
        compose.onNodeWithText("Claude & Codex").performScrollTo().performClick()
        compose.waitUntil(5_000) { compose.onAllNodes(androidx.compose.ui.test.hasText("25% used")).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("25% used").assertExists()
        compose.onNodeWithText("56% used").assertExists()
        assertTrue(writes.isEmpty())
    }
    @Test fun `inbox picker writes selected days while keeping thread concurrency`() {
        mount()
        compose.onNodeWithText("Inbox settlement").performScrollTo().performClick()
        compose.waitUntil(5_000) { compose.onAllNodes(androidx.compose.ui.test.hasText("1 day")).fetchSemanticsNodes().any { it.config.getOrNull(SemanticsProperties.Disabled) == null } }
        compose.waitForIdle()
        compose.onNodeWithText("1 day").performClick()
        compose.waitUntil(5_000) { writes.isNotEmpty() }
        compose.waitUntil(5_000) { compose.onAllNodes(androidx.compose.ui.test.hasText("1 day")).fetchSemanticsNodes().any { it.config.getOrNull(SemanticsProperties.Selected) == true } }
        assertTrue(writes.single().contains("\"maxConcurrentPerBot\":5"))
        assertTrue(writes.single().contains("\"autoSettleDays\":1"))
    }
}
