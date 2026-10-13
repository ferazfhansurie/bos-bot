package com.openmausbot.companion.ui

import org.junit.Test
import org.junit.Assert.*
import com.openmausbot.companion.core.PendingMessageAttachment

class ComposerPayloadTest {
    @Test fun editsCannotReuseThePayloadIdentityOfAnUncertainSend() {
        val item = PendingMessageAttachment("file-id", byteArrayOf(1), "notes.txt", "text/plain", PendingMessageAttachment.Kind.FILE)
        assertEquals(composerPayload("hello", listOf(item)), composerPayload("hello", listOf(item)))
        assertNotEquals(composerPayload("hello", listOf(item)), composerPayload("edited", listOf(item)))
        assertNotEquals(composerPayload("hello", listOf(item)), composerPayload("hello", emptyList()))
    }
    @Test fun attachmentMenuMatchesCurrentPhoneActions() {
        assertEquals(listOf(ChatActionId.PHOTOS, ChatActionId.FILES, ChatActionId.AUDIO), ChatActions.composer(true, false).map { it.id })
        assertEquals(listOf(ChatActionId.RECORD_AUDIO, ChatActionId.SAVED_RECORDINGS), ChatActions.audio(false).map { it.id })
        assertFalse(ChatActions.composer(false, true).any { it.enabled })
    }
}
