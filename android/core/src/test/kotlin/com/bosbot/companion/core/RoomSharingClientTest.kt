package com.openmausbot.companion.core
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.*
import kotlin.test.*
class RoomSharingClientTest {
    @Test fun patchesOnlyRequestedRoomFieldsAndPreservesExplicitPhotoClear() = runBlocking<Unit> {
        MockWebServer().use { server ->
            server.start()
            val client = CompanionClient(requireNotNull(Connection.parse(server.url("/").toString())), "fixture-token")
            val room = decodeFixture<Fleet>("bots-paged").groups.first().copy(id = "room")
            server.enqueue(MockResponse().setBody(CompanionJson.encodeToString(CreatedRoom(room))))
            client.updateRoomSettings("room", buildJsonObject { put("avatarUrl", JsonNull) })
            val request = server.takeRequest()
            assertEquals("PATCH", request.method); assertEquals("/api/groups/room", request.path)
            assertEquals(setOf("avatarUrl"), CompanionJson.parseToJsonElement(request.body.readUtf8()).jsonObject.keys)
            assertFailsWith<APIError.BadUrl> { client.updateRoomSettings("room", buildJsonObject { put("approvalMode", "full") }) }
            assertEquals(1, server.requestCount)
        }
    }
    @Test fun personalPhotoReadUsesActualConfigAvatarAndWritePreservesNull() = runBlocking<Unit> {
        MockWebServer().use { server ->
            server.start()
            val client = CompanionClient(requireNotNull(Connection.parse(server.url("/").toString())), "fixture-token")
            server.enqueue(MockResponse().setBody("""{"actorId":"person","homeId":"home","name":"Fixture"}"""))
            server.enqueue(MockResponse().setBody("""{"profile":{"avatarUrl":"/api/attachments/photo.jpg"}}"""))
            assertEquals("/api/attachments/photo.jpg", client.sharedMe().avatar)
            assertEquals("/api/multiplayer/me", server.takeRequest().path); assertEquals("/api/config", server.takeRequest().path)
            server.enqueue(MockResponse().setBody("""{"profile":{"avatarUrl":"/api/attachments/photo.jpg"}}"""))
            server.enqueue(MockResponse().setBody("{}")); client.setProfilePhoto(null)
            assertEquals("/api/config", server.takeRequest().path)
            val request = server.takeRequest()
            assertEquals("PUT", request.method); assertEquals("/api/multiplayer/profile-photo", request.path)
            val body = CompanionJson.parseToJsonElement(request.body.readUtf8()).jsonObject
            assertEquals(JsonNull, body["photo"])
            assertEquals(JsonPrimitive("/api/attachments/photo.jpg"), body["expected"])
        }
    }
}
