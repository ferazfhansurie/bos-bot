package com.openmausbot.companion.core
import kotlin.test.*
class SharedChatModelTest {
    @Test fun settledActivitySupersedesOnlyItsOwnActorRequestAndRoom() {
        val start = SharedChatMessage("start", "room", 1, SharedActor("home", "bot", "bot"), "", 1.0, "activity-work-start", responseTo = "question", kind = "activity", tool = SharedTool("working"))
        val settled = start.copy(id = "done", sequence = 5, sendId = "activity-work-ok", tool = SharedTool("working", true))
        val otherActor = start.copy(id = "actor", actor = SharedActor("other-home", "bot", "bot"))
        val otherRequest = start.copy(id = "request", responseTo = "other-question")
        val otherRoom = start.copy(id = "room", roomId = "other-room")
        assertEquals(listOf(otherActor, otherRequest, otherRoom, settled), SharedChatMessage.visible(listOf(start, otherActor, otherRequest, otherRoom, settled)))
        assertEquals("Completed", settled.activityLabel); assertEquals("question", settled.replyReference)
        assertNull(settled.copy(deletedAt = 2.0).replyReference)
    }
    @Test fun sameNameMentionChoicesRemainDistinctByTrustedActorIdentity() {
        val choices = SharedMentionChoice.choices(listOf(SharedContact("human", "Sam", "person"), SharedContact("outsider", "Sam", "person")), listOf("human"), listOf(SharedEligibleBot("bot-a", "sam", ownerName = "Owner"), SharedEligibleBot("bot-b", "Sam", ownerName = "Owner")))
        assertEquals(listOf("human", "bot-a", "bot-b"), choices.map { it.id })
        assertEquals(listOf("Sam · person", "sam · Owner · bot-a", "Sam · Owner · bot-b"), choices.map { it.label })
        assertEquals(listOf("bot-a", "bot-b"), SharedMentionChoice.matching(choices, "owner").map { it.id })
    }
    @Test fun retriesRetainIdentityOnlyForIdenticalTextFilesAndReply() {
        val draft = SharedSendDraft("hello", listOf("a"), "reply")
        assertEquals("durable", draft.sendID(draft.copy(), "durable"))
        assertNotEquals("durable", draft.copy(replyTo = null).sendID(draft, "durable"))
        assertNotEquals("durable", draft.copy(fileIDs = listOf("b")).sendID(draft, "durable"))
    }
    @Test fun requestCancellationRequiresActiveRequestAndItsOwnerOrRequester() {
        val request = SharedBotRequest("r", "room", "source", "requester", "bot", "Bot", "owner", "Owner", "waiting-approval", 1.0, 2.0)
        assertTrue(request.canCancel("owner")); assertTrue(request.canCancel("requester")); assertFalse(request.canCancel("other"))
        assertFalse(request.copy(state = "completed").canCancel("owner"))
    }
}
