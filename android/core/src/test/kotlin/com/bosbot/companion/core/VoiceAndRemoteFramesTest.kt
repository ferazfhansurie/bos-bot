package com.openmausbot.companion.core

import kotlinx.serialization.decodeFromString
import kotlin.test.*

class VoiceAndRemoteFramesTest {
    @Test fun ringFramesDecodeLenientlyAndDropSpoofedConnectionIdentity() {
        val frame = CompanionJson.decodeFromString<StreamFrame>("""{"kind":"voice_ring","ringId":"ring","botId":"bot","connectionId":"foreign"}""").frame as Frame.VoiceRing
        assertNull(frame.ring.connectionId)
        assertFalse(frame.ring.inApp)
        assertIs<Frame.Unknown>(CompanionJson.decodeFromString<StreamFrame>("""{"kind":"voice_ring","ringId":"","botId":"bot"}""").frame)
    }
    @Test fun remoteFramesCannotTouchOtherRoomsPrivateBotsNotificationsOrCursor() {
        val room = decodeFixture<Fleet>("bots-paged").groups.first().copy(id = "room", threadId = "joined", home = RoomHome("remote", "Remote"))
        val message = Message("m", Message.Role.BOT, Message.Kind.TEXT, 1.0, text = "hello")
        assertNull(remoteRoomFrame(listOf(room), "remote", Frame.Message("private", message)))
        assertNull(remoteRoomFrame(listOf(room), "remote", Frame.Bot(decodeFixture<Fleet>("bots-paged").bots.first())))
        assertNull(remoteRoomFrame(listOf(room), "remote", Frame.VoiceRing(VoiceRing("ring", "bot"))))
        assertNotNull(remoteRoomFrame(listOf(room), "remote", Frame.Message("joined", message)))
        val unstamped = room.copy(home = null)
        val stamped = remoteRoomFrame(listOf(room), "remote", Frame.Room(unstamped)) as Frame.Room
        assertEquals(room.home, stamped.room.home)
        assertEquals(mapOf("remote" to "room"), remoteRoomStreams(listOf(room, room.copy(id = "second"))))
    }
    @Test fun voiceRepliesRequireSettledTextAndExactNearestUserOrigin() {
        val asked = Message("ask", Message.Role.USER, Message.Kind.TEXT, 1.0, text = "request", origin = MessageOrigin(callId = "call"))
        val answer = Message("answer", Message.Role.BOT, Message.Kind.TEXT, 2.0, text = "result", parentId = "ask", turnTerminal = true)
        val later = Message("later", Message.Role.USER, Message.Kind.TEXT, 3.0, text = "typed", parentId = "answer")
        val other = Message("other", Message.Role.BOT, Message.Kind.TEXT, 4.0, text = "typed result", parentId = "later", turnTerminal = true)
        assertEquals(listOf("answer"), landedVoiceReplies(listOf(asked, answer, later, other), "call", 1.0, true).map { it.id })
        assertTrue(landedVoiceReplies(listOf(asked, answer.copy(turnTerminal = false)), "call", 1.0, true).isEmpty())
        assertTrue(landedVoiceReplies(listOf(asked, answer), "different-call", 1.0, false).isEmpty())
        assertTrue(landedVoiceReplies(listOf(answer), "call", 1.0, false).isEmpty())
    }
}
