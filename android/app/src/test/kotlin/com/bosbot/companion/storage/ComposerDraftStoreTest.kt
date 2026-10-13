package com.openmausbot.companion.storage

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.openmausbot.companion.core.PendingMessageAttachment
import java.io.File
import org.junit.After
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class ComposerDraftStoreTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val store = ComposerDraftStore(context)
    @After fun clean() { File(context.filesDir, "composer-drafts").deleteRecursively(); File(context.filesDir, "composer-attachments").deleteRecursively() }
    private fun attachment(id: String = "one") = PendingMessageAttachment(id, "notes".toByteArray(), "notes.txt", "text/plain", PendingMessageAttachment.Kind.FILE)

    @Test fun processRestartRetainsDraftBytesAndLogicalSendIdentity() {
        store.save("home-a:thread", "keep these words", "send-uuid", listOf(attachment()), payload = "stable-payload")
        val restored = ComposerDraftStore(context).restore("home-a:thread")!!
        assertEquals("keep these words", restored.typed)
        assertEquals("send-uuid", restored.sendId)
        assertEquals("stable-payload", restored.payload)
        assertEquals("one", restored.attachments.single().id)
        assertEquals("notes", restored.attachments.single().file!!.readText())
    }
    @Test fun equalThreadIdsOnDifferentHomesNeverShareDrafts() {
        store.save("home-a:same", "private a", "send-a", listOf(attachment()))
        assertNull(store.restore("home-b:same"))
    }
    @Test fun removeAndConfirmedSendDisposePrivateDraftCopies() {
        store.save("scope", "text", "id", listOf(attachment("one"), attachment("two")))
        val first = store.restore("scope")!!.attachments.first().file!!
        store.save("scope", "text", "id", listOf(attachment("two")))
        assertFalse(first.exists())
        val last = store.restore("scope")!!.attachments.single().file!!
        store.clear("scope")
        assertFalse(last.exists())
    }
    @Test fun cleanupNeverDeletesAnUnmanagedOriginalOrARecoverableDraft() {
        val original = File(context.filesDir, "original.txt").apply { writeText("original") }
        val pending = PendingMessageAttachment(name = "original.txt", mime = "text/plain", kind = PendingMessageAttachment.Kind.FILE, file = original)
        store.save("scope", "text", "id", listOf(pending))
        store.dispose(pending); store.cleanOrphans()
        assertTrue(original.exists())
        assertNotNull(store.restore("scope"))
        original.delete()
    }
    @Test fun unfinishedImportDoesNotRemainAfterProcessStartup() {
        val dir = File(context.filesDir, "composer-attachments").apply { mkdirs() }
        val orphan = File(dir, "attachment-orphan.media").apply { writeText("private") }
        store.cleanOrphans()
        assertFalse(orphan.exists())
    }
}
