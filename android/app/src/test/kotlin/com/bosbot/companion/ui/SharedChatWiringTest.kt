package com.openmausbot.companion.ui

import androidx.activity.ComponentActivity
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.MotionDurationScale
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import com.openmausbot.companion.core.*
import okhttp3.mockwebserver.*
import kotlinx.serialization.json.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.concurrent.CopyOnWriteArrayList

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
@OptIn(ExperimentalTestApi::class)
class SharedChatWiringTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>(effectContext = object : MotionDurationScale { override val scaleFactor = 0f })
    private var includeGroup = false
    private var meActor = "home:person:owner"
    private val writes = CopyOnWriteArrayList<String>()
    private val requests = CopyOnWriteArrayList<String>()
    private val server = MockWebServer().apply { dispatcher = object : Dispatcher() {
        override fun dispatch(request: RecordedRequest): MockResponse {
            requests += "${request.method} ${request.path}"
            val path = request.path.orEmpty()
            if (path == "/api/multiplayer/me") return MockResponse().setBody("{\"actorId\":\"$meActor\",\"homeId\":\"home\",\"role\":\"owner\",\"name\":\"Fixture owner\"}")
            if (path == "/api/multiplayer/contacts") return MockResponse().setBody("{\"contacts\":[{\"id\":\"home:person:peer\",\"name\":\"Peer\",\"kind\":\"person\"}]}")
            if (path == "/api/multiplayer/rooms") {
                val dm = """{"id":"room","homeId":"home","name":"DM","memberIds":["home:person:owner","home:person:peer"],"createdAt":1,"kind":"dm","preview":"hello from peer","unreadCount":2}"""
                val group = """{"id":"group","homeId":"home","name":"Fixture group","memberIds":["home:person:owner","home:person:peer"],"createdAt":1,"kind":"group","preview":"group preview"}"""
                return MockResponse().setBody("""{"rooms":[$dm${if (includeGroup) ",$group" else ""}]}""")
            }
            if (path.endsWith("/preferences")) return MockResponse().setBody("{\"readSequence\":0,\"notifications\":\"all\",\"replyMode\":\"follow\"}")
            if (path.endsWith("/bots")) return MockResponse().setBody("{\"bots\":[]}")
            if (path.startsWith("/api/multiplayer/rooms/room/messages")) {
                if (request.method == "POST") { writes += request.body.readUtf8(); return if (writes.size == 1) MockResponse().setResponseCode(503).setBody("{\"error\":\"delivery unavailable\"}") else MockResponse().setResponseCode(204) }
                return MockResponse().setBody("{\"messages\":[{\"id\":\"m1\",\"roomId\":\"room\",\"sequence\":1,\"actor\":{\"homeId\":\"home\",\"kind\":\"person\",\"localId\":\"peer\"},\"text\":\"hello from peer\",\"at\":1000,\"sendId\":\"existing\"}],\"version\":1,\"hasMore\":false}")
            }
            if (path == "/.well-known/openmausbot/environment") return MockResponse().setBody("{\"environmentId\":\"fixture\",\"label\":\"fixture\"}")
            return MockResponse().setResponseCode(404)
        }
    }; start() }
    @After fun close() { server.shutdown() }
    @Test fun `uncertain delivery preserves draft and explicit retry reuses send id and reply origin`() {
        val scene = WiringScene(Connection(id = "shared-${System.nanoTime()}", name = "Fixture", host = "127.0.0.1", port = server.port))
        val room = SharedRoomSummary("room", "home", "", listOf("home:person:owner", "home:person:peer"), 1.0, kind = "dm")
        var showing by mutableStateOf(true)
        compose.setContent { CompositionLocalProvider(LocalCompanion provides scene.environment) { CompanionTheme(darkTheme = false) { if (showing) SharedChatScreen(scene.session, scene.session.connection.value!!.id, room, "home:person:owner", listOf(SharedContact("home:person:peer", "Peer", "person")), {}, {}) } } }
        compose.waitUntil(5_000) { compose.onAllNodesWithText("hello from peer").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("hello from peer").performTouchInput { longClick(center) }
        compose.onNodeWithText("Reply", useUnmergedTree = true).performClick()
        compose.onNodeWithText("Message").performTextInput("retry fixture")
        compose.onNodeWithText("Send").performClick()
        compose.waitUntil(5_000) { writes.size == 1 && compose.onAllNodesWithText("Send").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("retry fixture").assertExists()
        compose.mainClock.advanceTimeBy(5_000)
        assertEquals("an uncertain send must never automatically replay", 1, writes.size)
        compose.runOnIdle { showing = false }; compose.waitForIdle()
        compose.runOnIdle { showing = true }
        compose.waitUntil(5_000) { compose.onAllNodesWithText("retry fixture").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Send").performClick()
        compose.waitUntil(5_000) { writes.size == 2 }
        val first = CompanionJson.parseToJsonElement(writes[0]).jsonObject
        val second = CompanionJson.parseToJsonElement(writes[1]).jsonObject
        assertEquals(first["sendId"], second["sendId"])
        assertEquals("m1", first["replyTo"]!!.jsonPrimitive.content)
        assertTrue(requests.any { it.contains("latest=1") })
    }
    @Test fun `shared details expose real notification and group management boundaries`() {
        val scene = WiringScene(Connection(id = "details-${System.nanoTime()}", name = "Fixture", host = "127.0.0.1", port = server.port))
        val room = SharedRoomSummary("room", "home", "Fixture group", listOf("home:person:owner", "home:person:peer"), 1.0, kind = "group", createdBy = "home:person:owner", revision = 4)
        compose.setContent { CompositionLocalProvider(LocalCompanion provides scene.environment) { CompanionTheme(darkTheme = false) { SharedGroupSettingsScreen(scene.session, scene.session.connection.value!!.id, room, "home:person:peer", emptyList(), emptyList(), {}, {}, {}, {}, {}, {}) } } }
        compose.onNodeWithText("Only the owner can rename the group or change members.").assertExists()
        compose.onNodeWithText("Save name").assertDoesNotExist()
        compose.onNodeWithText("Delete group").assertDoesNotExist()
        compose.onNodeWithText("Shared files").assertExists()
        compose.onNodeWithText("Bot requests").assertExists()
    }
    @Test fun `collapsed people open one existing dm row using authenticated actor without a second dm write`() {
        val scene = WiringScene(Connection(id = "roster-shared-${System.nanoTime()}", name = "Fixture", host = "127.0.0.1", port = server.port))
        var opened: SharedRoomSummary? = null
        var actor: String? = null
        compose.setContent { CompositionLocalProvider(LocalCompanion provides scene.environment) { CompanionTheme(darkTheme = false) { SharedRosterPanel(scene.session, scene.session.connection.value!!.id) { room, selfId, _ -> opened = room; actor = selfId } } } }
        compose.onNodeWithText("Peer").assertDoesNotExist()
        compose.waitUntil(5_000) { compose.onAllNodesWithText("People", substring = true).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("People", substring = true).performClick()
        compose.waitUntil(5_000) { compose.onAllNodesWithText("Peer").fetchSemanticsNodes().isNotEmpty() }
        compose.onAllNodesWithText("Peer").assertCountEquals(1)
        compose.onNodeWithText("Peer").performClick()
        compose.runOnIdle { assertEquals("room", opened?.id); assertEquals("home:person:owner", actor) }
        assertFalse(requests.any { it.startsWith("POST /api/multiplayer/dm") })
    }

    @Test fun `changed authenticated actor never renders or sends restored private draft`() {
        meActor = "home:person:other"
        val owner = "home:person:owner"
        val connection = Connection(id = "changed-shared-${System.nanoTime()}", name = "Fixture", host = "127.0.0.1", port = server.port)
        val scene = WiringScene(connection)
        val store = SharedDraftStore(compose.activity.filesDir, connection.id, "room", owner)
        store.save(SharedDraftCheckpoint(typedText = "private recovered fixture"))
        val room = SharedRoomSummary("room", "home", "Fixture", listOf(owner, "home:person:peer"), 1.0, kind = "dm")
        compose.setContent { CompositionLocalProvider(LocalCompanion provides scene.environment) { CompanionTheme(darkTheme = false) { SharedChatScreen(scene.session, connection.id, room, owner, emptyList(), {}, {}) } } }
        compose.waitUntil(5_000) { compose.onAllNodesWithText("The signed-in person changed. Reopen this conversation.").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("private recovered fixture").assertDoesNotExist()
        compose.onNodeWithText("Send").assertDoesNotExist()
        assertFalse(requests.any { it.contains("/room/messages") })
        assertEquals("private recovered fixture", store.restore().typedText)
    }

    @Test fun `shared groups stay outside people fold and pin hide controls retain owning home`() {
        includeGroup = true
        val connection = Connection(id = "shared-layout-${System.nanoTime()}", name = "Fixture", host = "127.0.0.1", port = server.port)
        val scene = WiringScene(connection)
        compose.setContent { CompositionLocalProvider(LocalCompanion provides scene.environment) { CompanionTheme(darkTheme = false) { SharedRosterPanel(scene.session, connection.id) { _, _, _ -> } } } }
        compose.waitUntil(5_000) { compose.onAllNodesWithText("Fixture group").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Peer").assertDoesNotExist()
        compose.onNodeWithText("Fixture group").performTouchInput { longClick(center) }
        compose.onNodeWithText("Pin chat").performClick()
        compose.onAllNodesWithText("Fixture group").assertCountEquals(1)
        compose.onNodeWithText("Peer").assertDoesNotExist()
        compose.onNodeWithText("Fixture group").performTouchInput { longClick(center) }
        compose.onNodeWithText("Unpin chat").assertExists()
        compose.onNodeWithText("Hide chat").performClick()
        compose.onNodeWithText("Fixture group").assertDoesNotExist()
        compose.onNodeWithText("Show hidden chats").performClick()
        compose.onNodeWithText("Fixture group").performTouchInput { longClick(center) }
        compose.onNodeWithText("Show chat").performClick()
        compose.onNodeWithText("Fixture group").assertExists()
        val preferences = compose.activity.getSharedPreferences("shared-roster-layout", android.content.Context.MODE_PRIVATE)
        assertEquals(setOf("room:group"), preferences.getStringSet("${connection.id}.home:person:owner.pins", emptySet()))
        assertTrue(preferences.getStringSet("${connection.id}.home:person:owner.hidden", emptySet())!!.isEmpty())
    }

}
