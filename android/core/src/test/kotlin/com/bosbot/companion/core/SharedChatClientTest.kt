package com.openmausbot.companion.core

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.*
import kotlin.test.*

class SharedChatClientTest {
    private fun client(server: MockWebServer) = CompanionClient(requireNotNull(Connection.parse(server.url("/").toString())), "fixture-token")
    @Test fun pagesCarryIndependentSequenceAndVersionCursors() = runBlocking<Unit> {
        MockWebServer().use { server ->
            server.start(); server.enqueue(MockResponse().setBody("""{"messages":[],"changes":[],"version":9,"hasMore":true,"typing":["person"]}"""))
            val page = client(server).sharedMessagePage("room", after = 7, version = 8, before = 20, latest = true)
            assertEquals(9, page.version); assertEquals(listOf("person"), page.typing)
            assertEquals("/api/multiplayer/rooms/room/messages?after=7&version=8&limit=200&before=20&latest=1", server.takeRequest().path)
        }
    }
    @Test fun sendRetainsDurableIdentityAndDoesNotRetryAmbiguousFailure() = runBlocking<Unit> {
        MockWebServer().use { server ->
            server.start(); val client = client(server)
            val id = "01234567-89ab-cdef-0123-456789abcdef"
            server.enqueue(MockResponse().setResponseCode(503).setBody("""{"error":"uncertain"}"""))
            val error = assertFailsWith<APIError.Status> { client.sendSharedMessage("room", "hello", id, replyTo = "message") }
            assertEquals(503, error.code); assertEquals(1, server.requestCount)
            val body = CompanionJson.parseToJsonElement(server.takeRequest().body.readUtf8()).jsonObject
            assertEquals(id, body["sendId"]?.jsonPrimitive?.content); assertEquals("message", body["replyTo"]?.jsonPrimitive?.content)
            assertEquals(emptyList(), body["attachments"]?.jsonArray?.toList())
            server.enqueue(MockResponse().setBody("{}")); client.sendSharedMessage("room", "hello", id, replyTo = "message")
            assertEquals(body, CompanionJson.parseToJsonElement(server.takeRequest().body.readUtf8()))
        }
    }
    @Test fun invalidSharedAttachmentSetsFailBeforeNetwork() = runBlocking<Unit> {
        MockWebServer().use { server ->
            server.start(); val client = client(server)
            val file = SharedAttachment("file", "file.pdf", "application/pdf", 25 * 1024 * 1024)
            val id = "01234567-89ab-cdef-0123-456789abcdef"
            for (files in listOf(List(5) { file.copy(id = "file-$it") }, List(33) { file.copy(id = "file-$it", size = 1) }, listOf(file.copy(size = -1)), listOf(file.copy(name = "../file")), listOf(file, file), listOf(file.copy(mime = "application/executable")))) {
                assertFailsWith<APIError.Transport> { client.sendSharedMessage("room", "file", id, files) }
            }
            assertEquals(0, server.requestCount)
        }
    }
    @Test fun preferencesClearUsesExplicitNullAndRoomRevisionConflictSurfaces() = runBlocking<Unit> {
        MockWebServer().use { server ->
            server.start(); val client = client(server)
            val prefs = """{"readSequence":3,"notifications":"all"}"""
            server.enqueue(MockResponse().setBody(prefs)); client.sharedPreferences("room")
            assertEquals("GET", server.takeRequest().method)
            server.enqueue(MockResponse().setBody(prefs)); client.sharedPreferences("room", replyBotId = "")
            val request = server.takeRequest(); assertEquals("PATCH", request.method)
            assertEquals(buildJsonObject { put("replyBotId", JsonNull) }, CompanionJson.parseToJsonElement(request.body.readUtf8()))
            server.enqueue(MockResponse().setResponseCode(409).setBody("""{"error":"changed"}"""))
            assertFailsWith<APIError.Status> { client.updateSharedRoom("room", 4, name = "new") }
            val patch = CompanionJson.parseToJsonElement(server.takeRequest().body.readUtf8()).jsonObject
            assertEquals(setOf("revision", "name"), patch.keys); assertEquals(4, patch["revision"]?.jsonPrimitive?.int)
            assertEquals(3, server.requestCount)
        }
    }
    @Test fun attachmentIdentityAndDecodedSizeAreVerified() = runBlocking<Unit> {
        MockWebServer().use { server ->
            server.start(); val client = client(server)
            val attachment = SharedAttachment("file", "note.txt", "text/plain", 3)
            server.enqueue(MockResponse().setBody(CompanionJson.encodeToString(SharedAttachmentResponse(attachment))))
            assertEquals(attachment, client.uploadSharedAttachment("room", "note.txt", "text/plain", byteArrayOf(1,2,3)))
            val upload = CompanionJson.parseToJsonElement(server.takeRequest().body.readUtf8()).jsonObject
            assertEquals("AQID", upload["data"]?.jsonPrimitive?.content)
            server.enqueue(MockResponse().setBody(CompanionJson.encodeToString(SharedAttachmentData(attachment, "AQID"))))
            assertContentEquals(byteArrayOf(1,2,3), client.sharedAttachment("room", "file").bytes())
            server.takeRequest()
            server.enqueue(MockResponse().setBody(CompanionJson.encodeToString(SharedAttachmentData(attachment.copy(id = "other"), "AQID"))))
            assertFailsWith<APIError.Transport> { client.sharedAttachment("room", "file") }; server.takeRequest()
            assertFailsWith<APIError.Transport> { SharedAttachmentData(attachment, "AQI=").bytes() }
            assertFailsWith<APIError.Transport> { client.uploadSharedAttachment("room", "../note", "text/plain", byteArrayOf(1)) }
            assertEquals(3, server.requestCount)
        }
    }
}
