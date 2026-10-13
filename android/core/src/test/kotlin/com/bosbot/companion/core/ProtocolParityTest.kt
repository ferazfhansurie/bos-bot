package com.openmausbot.companion.core

import java.io.File
import java.io.RandomAccessFile
import kotlin.test.*
import kotlinx.serialization.decodeFromString

class ProtocolParityTest {
    private fun message(id: String) = Message(id, Message.Role.USER, Message.Kind.TEXT, 1.0, text = "hello")

    @Test fun typedSteerReceiptReconcilesOnlyExactThreadAndTombstonesConsumedQueues() {
        val receipt = CompanionJson.decodeFromString<SteerReceipt>("""{"threadId":"thread","outcomeUnknown":true,"queueIds":["queue"],"messages":[{"id":"message","role":"user","kind":"text","at":1}]}""")
        val initial = CompanionState().rememberQueued(QueuedSend("queue", "hello"), "thread")
        assertEquals(initial, receipt.apply(initial, "other"))
        val applied = receipt.apply(initial, "thread")
        assertTrue(applied.pendingQueued.isEmpty())
        assertEquals(SteeringStatus.UNCERTAIN, applied.transcript("thread").single().steeringStatus)
        assertTrue(applied.rememberQueued(QueuedSend("queue", "hello"), "thread").pendingQueued.isEmpty())
        assertEquals(initial, receipt.copy(outcomeUnknown = false, interrupted = true, queued = true).apply(initial, "thread"))
    }

    @Test fun sendReceiptKeepsInterruptedAndUnknownOutcomes() {
        val receipt = CompanionJson.decodeFromString<SendReceiptBody>("""{"threadId":"t","interrupted":true,"outcomeUnknown":true,"steerDelivery":"outcome_unknown"}""").receipt() as SendReceipt.Sent
        assertTrue(receipt.interrupted)
        assertTrue(receipt.outcomeUnknown)
        assertEquals("outcome_unknown", receipt.delivery)
    }

    @Test fun negotiatedTaskDeltasRequireStreamBaselineAndResetAtHello() {
        val bot = decodeFixture<Fleet>("bots-paged").bots.first()
        val one = BotTask("one", "one", 1.0)
        val two = BotTask("two", "two", 2.0)
        val full = bot.copy(tasks = listOf(one, two))
        val initial = CompanionState().apply(StreamFrame(Frame.Bot(full)))
        val delta = bot.copy(tasks = listOf(two.copy(title = "changed")), taskOrder = listOf("two", "one"))
        val changed = initial.apply(StreamFrame(Frame.Bot(delta)))
        assertEquals(listOf("two", "one"), changed.bot(bot.id)!!.tasks!!.map { it.threadId })
        assertEquals("changed", changed.bot(bot.id)!!.tasks!!.first().title)
        assertNull(changed.bot(bot.id)!!.taskOrder)
        val hello = changed.apply(StreamFrame(Frame.Hello("epoch:3", true)))
        assertEquals(hello, hello.apply(StreamFrame(Frame.Bot(delta))))
        assertEquals(initial, initial.apply(StreamFrame(Frame.Bot(delta.copy(taskOrder = listOf("missing"))))))
    }

    @Test fun botLocalMarkdownImagesDeduplicateTagsButKeepExamplesAndRemoteImages() {
        val source = """<attached-image path="/tmp/my image.png" />
![image](</tmp/my%20image.png>)
![remote](https://example.com/image.png)
```md
![example](/tmp/example.png)
```
"""
        val parsed = AttachedMessageContent.parse(source, markdownImages = true)
        assertEquals(1, parsed.attachments.size)
        assertTrue(parsed.text.contains("https://example.com"))
        assertTrue(parsed.text.contains("![example]"))
        assertFalse(parsed.text.contains("my%20image"))
        assertEquals(1, AttachedMessageContent.parse("- [![image](/tmp/a.png)](/tmp/a.png)", true).attachments.size)
        assertTrue(AttachedMessageContent.parse("text ![image](/tmp/a.png)", true).attachments.isEmpty())
        assertTrue(AttachedMessageContent.parse("![image](/tmp/a.png)").attachments.isEmpty())
    }

    @Test fun roomBotsStreamIndependentlyAndSettlingOneDoesNotEraseAnother() {
        var state = CompanionState()
        state = state.apply(Frame.Runtime(RuntimeEvent("content.delta", "room", "one", "assistant_text", roomBotId = "bot1")))
        state = state.apply(Frame.Runtime(RuntimeEvent("content.delta", "room", "two", "assistant_text", roomBotId = "bot2")))
        assertEquals("one", state.streaming["room:room:bot1"])
        assertEquals("two", state.streaming["room:room:bot2"])
        state = state.apply(Frame.Runtime(RuntimeEvent("item.completed", "room", roomBotId = "bot1")))
        assertNull(state.streaming["room:room:bot1"])
        assertEquals("two", state.streaming["room:room:bot2"])
        assertTrue(state.clearStream("room").streaming.isEmpty())
    }

    @Test fun largeFilesAreFileBackedAndVideoUsesFilePolicy() {
        val file = File.createTempFile("parity", ".mp4")
        try {
            RandomAccessFile(file, "rw").use { it.setLength(90L * 1024 * 1024) }
            val attachment = PendingMessageAttachment(name = "video.mp4", mime = "video/mp4", kind = PendingMessageAttachment.Kind.FILE, file = file)
            AttachmentPolicy.validate(listOf(attachment))
            assertEquals(90L * 1024 * 1024, attachment.bytes)
            assertEquals(PendingMessageAttachment.Kind.FILE, AttachmentPolicy.kindForMime("video/quicktime"))
            RandomAccessFile(file, "rw").use { it.setLength(90L * 1024 * 1024 + 1) }
            assertFailsWith<AttachmentPolicyException> { AttachmentPolicy.validate(listOf(attachment)) }
        } finally { file.delete() }
    }
}
