package com.openmausbot.companion.ui

import com.openmausbot.companion.core.*
import org.junit.Assert.*
import org.junit.Test

class SharedChatUiPolicyTest {
    @Test fun `mentions require a separate token`() {
        assertNull(SharedChatUiPolicy.query("email@example.com"))
        assertNull(SharedChatUiPolicy.query("@bot\ncontinued"))
        assertEquals(5 to "bo", SharedChatUiPolicy.query("help @bo"))

    }
    @Test fun `shared attachments use shared 25mb and 100mb caps before buffering upload`() {
        val file = java.io.File.createTempFile("shared-test", ".txt")
        try {
            java.io.RandomAccessFile(file, "rw").use { it.setLength(26L * 1024 * 1024) }
            val oversized = PendingMessageAttachment(name = "large.txt", mime = "text/plain", kind = PendingMessageAttachment.Kind.FILE, file = file)
            assertThrows(IllegalArgumentException::class.java) { SharedChatUiPolicy.validateFile(oversized, emptyList()) }
            java.io.RandomAccessFile(file, "rw").use { it.setLength(25L * 1024 * 1024) }
            SharedChatUiPolicy.validateFile(oversized, emptyList())
            assertThrows(IllegalArgumentException::class.java) { SharedChatUiPolicy.validateFile(oversized, List(4) { oversized }) }
        } finally { file.delete() }
    }
}
