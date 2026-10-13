package com.openmausbot.companion.core
import kotlin.test.*
class WalkieTest {
    private fun text(id: String, value: String, role: Message.Role = Message.Role.BOT) = Message(id, role, Message.Kind.TEXT, 1.0, text = value)
    @Test fun waitsForSettledReplyAndSkipsOwnWordsAndOldHistory() {
        val messages = listOf(text("old", "old"), text("you", "request", Message.Role.USER), text("new", "answer"))
        assertNull(Walkie.settledReply(messages, setOf("old"), true))
        assertEquals("answer", Walkie.settledReply(messages, setOf("old"), false))
        assertNull(Walkie.settledReply(messages, setOf("old", "new"), false))
    }
    @Test fun speaksMarkdownWithoutCodeOrUrlsAndBoundsUtterances() {
        val spoken = Walkie.speakable("# Result\n- **done** at [the report](https://example.com)\n```kotlin\nsecret example\n```", 600)
        assertFalse(spoken.contains("https://")); assertFalse(spoken.contains("secret example"))
        assertTrue(spoken.contains("the report")); assertTrue(spoken.contains("Code omitted"))
        val pieces = Walkie.utterances("word ".repeat(180) + "x".repeat(700), 320)
        assertTrue(pieces.all { it.length <= 320 }); assertTrue(pieces.size > 1)
        assertTrue(Walkie.speakable("sentence words ".repeat(100), 80).endsWith("The rest is in the chat."))
    }
    @Test fun archiveRollbackChangesOnlyItsOwnStampAndRetainsNewerUpdates() {
        val bot = decodeFixture<Fleet>("bots-paged").bots.first().copy(tasks = listOf(BotTask("target", "task", 1.0), BotTask("other", "other", 1.0)))
        val optimistic = CompanionState(bots = listOf(bot)).withTaskArchive(bot.id, "target", 123.0)
        assertEquals(123.0, optimistic.bot(bot.id)!!.tasks!!.first().archivedAt)
        val newer = optimistic.copy(bots = optimistic.bots.map { it.copy(name = "new name", tasks = it.tasks!!.map { task -> if (task.threadId == "target") task.copy(title = "new title") else task }) })
        val rollback = newer.withTaskArchive(bot.id, "target", null, 123.0, true)
        assertEquals("new name", rollback.bot(bot.id)!!.name)
        assertEquals("new title", rollback.bot(bot.id)!!.tasks!!.first().title)
        assertNull(rollback.bot(bot.id)!!.tasks!!.first().archivedAt)
        assertEquals(newer, newer.withTaskArchive(bot.id, "target", null, 456.0, true))
    }
}
