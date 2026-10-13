package com.openmausbot.companion.ui

import com.openmausbot.companion.core.*
import java.nio.file.Files
import org.junit.Assert.*
import org.junit.Test

class SharedDraftStoreTest {
    @Test fun `recreating owner draft restores private media and uncertain delivery references without another upload`() {
        val root = Files.createTempDirectory("shared-checkpoint").toFile()
        try {
            val first = SharedDraftStore(root, "computer", "room", "actor")
            val picked = PendingMessageAttachment(name = "note.txt", mime = "text/plain", kind = PendingMessageAttachment.Kind.FILE, data = "private fixture".toByteArray())
            val retained = first.adopt(picked)
            val attempt = SharedSendDraft("explicit dictated send", listOf(picked.id), "reply-id")
            val upload = SharedAttachment("uploaded-id", picked.name, picked.mime, picked.data.size)
            first.save(SharedDraftCheckpoint("typed baseline", first.records(listOf(retained)), "reply-id", attempt, "stable-send-id", mapOf(picked.id to upload)))
            val recreated = SharedDraftStore(root, "computer", "room", "actor")
            val recovered = recreated.restore()
            assertEquals("typed baseline", recovered.typedText)
            assertEquals("explicit dictated send", recovered.delivery?.text)
            assertEquals("stable-send-id", recovered.delivery!!.sendID(recovered.delivery, recovered.sendId))
            assertEquals("uploaded-id", recovered.uploaded[picked.id]?.id)
            assertArrayEquals(picked.data, recreated.pending(recovered).single().file!!.readBytes())
            assertTrue(SharedDraftStore(root, "other-computer", "room", "actor").restore().files.isEmpty())
            assertNull(SharedDraftStore(root, "computer", "room", "other-actor").restore().sendId)
            recreated.save(SharedDraftCheckpoint()) // acceptance commits before old media is disposed
            assertNull(SharedDraftStore(root, "computer", "room", "actor").restore().sendId)
        } finally { root.deleteRecursively() }
    }
    @Test fun `missing pending media blocks recovery instead of silently generating a new send`() {
        val root = Files.createTempDirectory("shared-missing").toFile()
        try {
            val store = SharedDraftStore(root, "computer", "room", "actor")
            val retained = store.adopt(PendingMessageAttachment(name = "x.txt", mime = "text/plain", kind = PendingMessageAttachment.Kind.FILE, data = byteArrayOf(1)))
            store.save(SharedDraftCheckpoint(files = store.records(listOf(retained)), delivery = SharedSendDraft("x", listOf(retained.id), null), sendId = "stable"))
            retained.file!!.delete()
            assertThrows(IllegalArgumentException::class.java) { SharedDraftStore(root, "computer", "room", "actor").restore() }
        } finally { root.deleteRecursively() }
    }
}
