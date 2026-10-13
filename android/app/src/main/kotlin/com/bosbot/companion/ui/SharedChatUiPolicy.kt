package com.openmausbot.companion.ui

import com.openmausbot.companion.core.*

internal object SharedChatUiPolicy {
    const val MAX_TOTAL_BYTES = 100L * 1024 * 1024
    fun query(text: String): Pair<Int, String>? {
        val start = text.lastIndexOf('@')
        if (start < 0 || (start > 0 && !text[start - 1].isWhitespace())) return null
        val tail = text.substring(start + 1)
        if (tail.length > 200 || '\n' in tail) return null
        return start to tail
    }
    fun validateFile(item: PendingMessageAttachment, current: List<PendingMessageAttachment>) {
        val limit = if (item.mime.startsWith("image/")) AttachmentPolicy.MAXIMUM_IMAGE_BYTES else AttachmentPolicy.MAXIMUM_BUFFERED_FILE_BYTES
        require(item.bytes in 1..limit.toLong()) { "Attachment must be under ${limit / 1024 / 1024} MB" }
        require(current.size < AttachmentPolicy.MAXIMUM_ITEMS) { AttachmentPolicy.TOO_MANY_ITEMS }
        require(current.sumOf { it.bytes } + item.bytes <= MAX_TOTAL_BYTES) { "Those attachments are larger than 100 MB together." }
    }
}
