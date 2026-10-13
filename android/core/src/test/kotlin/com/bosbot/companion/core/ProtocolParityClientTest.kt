package com.openmausbot.companion.core

import java.io.File
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import kotlin.test.*

class ProtocolParityClientTest {
    @Test fun sendsFreezeThreadAndCarryStableIdReplyAndBlockingPriority() = runBlocking<Unit> {
        MockWebServer().use { server ->
            server.start()
            val client = CompanionClient(requireNotNull(Connection.parse(server.url("/").toString())), "test-token")
            server.enqueue(MockResponse().setResponseCode(202).setBody("""{"threadId":"thread","interrupted":true}"""))
            val receipt = client.send("hello", MessageDestination.Bot("bot", "thread"), "stable-send-0001", "reply", MessagePriority.BLOCK)
            assertTrue((receipt as SendReceipt.Sent).interrupted)
            val request = server.takeRequest()
            assertEquals("/api/bots/bot/messages", request.path)
            assertEquals("Bearer test-token", request.getHeader("Authorization"))
            val body = CompanionJson.parseToJsonElement(request.body.readUtf8()).jsonObject
            assertEquals("stable-send-0001", body["sendId"]?.jsonPrimitive?.content)
            assertEquals("thread", body["threadId"]?.jsonPrimitive?.content)
            assertEquals("reply", body["replyToId"]?.jsonPrimitive?.content)
            assertEquals("block", body["priority"]?.jsonPrimitive?.content)
            assertFailsWith<APIError.BadUrl> { client.send("x", MessageDestination.Bot("bot", "thread"), "send", "../reply") }
        }
    }

    @Test fun fileBackedUploadPreservesBytesAndReturnedServerName() = runBlocking<Unit> {
        MockWebServer().use { server ->
            server.start()
            val client = CompanionClient(requireNotNull(Connection.parse(server.url("/").toString())), "test-token")
            val file = File.createTempFile("parity-upload", ".mp4")
            try {
                file.writeBytes(byteArrayOf(1, 2, 3, 4))
                server.enqueue(MockResponse().setBody("""{"path":"/tmp/upload.mp4","name":"clip.mp4","mime":"video/mp4","bytes":4}"""))
                val saved = client.uploadFile(file, "clip.mp4", "video/mp4", "123e4567-e89b-12d3-a456-426614174000")
                assertEquals("clip.mp4", saved.name)
                val request = server.takeRequest()
                assertEquals("/api/files", request.requestUrl?.encodedPath)
                assertEquals("123e4567-e89b-12d3-a456-426614174000", request.requestUrl?.queryParameter("uploadId"))
                assertEquals("video/mp4", request.getHeader("Content-Type"))
                assertContentEquals(byteArrayOf(1, 2, 3, 4), request.body.readByteArray())
            } finally { file.delete() }
        }
    }

    @Test fun roomEventsUseAuthenticatedRelayWithoutForeignCursor() = runBlocking<Unit> {
        MockWebServer().use { server ->
            server.start()
            val client = CompanionClient(requireNotNull(Connection.parse(server.url("/").toString())), "test-token")
            server.enqueue(MockResponse().setHeader("Content-Type", "text/event-stream")
                .setBody("data: {\"kind\":\"hello\",\"cursor\":\"foreign:9\",\"resumed\":false}\n\n"))
            assertEquals(1, client.roomEvents("room").take(1).toList().size)
            val request = server.takeRequest()
            assertEquals("/api/groups/room/events", request.path)
            assertEquals("Bearer test-token", request.getHeader("Authorization"))
            assertEquals("text/event-stream", request.getHeader("Accept"))
        }
    }

    @Test fun voiceCallAndTaskKeepCallAndSendIdentity() = runBlocking<Unit> {
        MockWebServer().use { server ->
            server.start()
            val client = CompanionClient(requireNotNull(Connection.parse(server.url("/").toString())), "test-token")
            server.enqueue(MockResponse().setBody("""{"callId":"call","plan":{}}"""))
            client.voiceCall("bot", "en", "call")
            var request = server.takeRequest()
            assertEquals("/api/voice/call", request.path)
            assertEquals("call", CompanionJson.parseToJsonElement(request.body.readUtf8()).jsonObject["callId"]?.jsonPrimitive?.content)
            server.enqueue(MockResponse().setBody("""{"threadId":"thread"}"""))
            client.sendVoiceTask("bot", "thread", "request", "call", "logical-voice-0001", " job ")
            request = server.takeRequest()
            val body = CompanionJson.parseToJsonElement(request.body.readUtf8()).jsonObject
            assertEquals("logical-voice-0001", body["sendId"]?.jsonPrimitive?.content)
            assertEquals("thread", body["threadId"]?.jsonPrimitive?.content)
            assertEquals("voice_call", body["origin"]!!.jsonObject["kind"]?.jsonPrimitive?.content)
            assertEquals("call", body["origin"]!!.jsonObject["callId"]?.jsonPrimitive?.content)
            assertEquals("job", body["origin"]!!.jsonObject["job"]?.jsonPrimitive?.content)
            server.enqueue(MockResponse().setBody("{}"))
            client.reportVoiceCallUsage("call", -3)
            request = server.takeRequest()
            assertEquals("/api/voice/call/usage", request.path)
            assertEquals(0, CompanionJson.parseToJsonElement(request.body.readUtf8()).jsonObject["seconds"]!!.jsonPrimitive.int)
        }
    }

    @Test fun settlementPreservesExistingConcurrencyAndBoundsDays() = runBlocking<Unit> {
        MockWebServer().use { server ->
            server.start()
            val client = CompanionClient(requireNotNull(Connection.parse(server.url("/").toString())), "test-token")
            server.enqueue(MockResponse().setBody("""{"threads":{"maxConcurrentPerBot":7,"autoSettleDays":0}}"""))
            server.enqueue(MockResponse().setBody("""{"threads":{"maxConcurrentPerBot":7,"autoSettleDays":30}}"""))
            assertEquals(30, client.setThreadSettlement(30).threads?.autoSettleDays)
            assertEquals("GET", server.takeRequest().method)
            val request = server.takeRequest()
            assertEquals("PATCH", request.method)
            val threads = CompanionJson.parseToJsonElement(request.body.readUtf8()).jsonObject["threads"]!!.jsonObject
            assertEquals(7, threads["maxConcurrentPerBot"]!!.jsonPrimitive.int)
            assertEquals(30, threads["autoSettleDays"]!!.jsonPrimitive.int)
            assertFailsWith<APIError.BadUrl> { client.setThreadSettlement(-1) }
        }
    }

    @Test fun queueSteeringPinsRoomMemberAndEditVerifiesExactReceipt() = runBlocking<Unit> {
        MockWebServer().use { server ->
            server.start()
            val client = CompanionClient(requireNotNull(Connection.parse(server.url("/").toString())), "test-token")
            val room = MessageDestination.Room("room", "thread")
            server.enqueue(MockResponse().setBody("""{"threadId":"thread","outcomeUnknown":true}"""))
            assertTrue(client.steerQueued("q", room, "bot").outcomeUnknown == true)
            var request = server.takeRequest()
            assertEquals("/api/groups/room/queue/q/steer", request.path)
            assertEquals("bot", CompanionJson.parseToJsonElement(request.body.readUtf8()).jsonObject["botId"]?.jsonPrimitive?.content)
            server.enqueue(MockResponse().setBody("""{"ok":true,"queueId":"q","threadId":"thread","text":"new"}"""))
            client.editQueued("q", room, "old", "new")
            request = server.takeRequest()
            assertEquals("PATCH", request.method)
            assertEquals("old", CompanionJson.parseToJsonElement(request.body.readUtf8()).jsonObject["expectedText"]?.jsonPrimitive?.content)
            server.enqueue(MockResponse().setBody("""{"ok":true,"queueId":"q","threadId":"different","text":"new"}"""))
            assertFailsWith<APIError.Status> { client.editQueued("q", room, "old", "new") }
        }
    }
}
