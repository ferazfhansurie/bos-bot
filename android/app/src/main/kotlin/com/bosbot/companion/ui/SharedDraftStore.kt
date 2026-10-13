package com.openmausbot.companion.ui

import com.openmausbot.companion.core.*
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString

@Serializable internal data class SharedPendingFile(val id: String, val name: String, val mime: String, val size: Long, val image: Boolean)
@Serializable internal data class SharedDraftCheckpoint(val typedText: String = "", val files: List<SharedPendingFile> = emptyList(),
    val replyTo: String? = null, val delivery: SharedSendDraft? = null, val sendId: String? = null,
    val uploaded: Map<String, SharedAttachment> = emptyMap(), val editedSinceDelivery: Boolean = false)

/** Private media and delivery identity survive leaving the screen or process death; restoration never sends. */
internal class SharedDraftStore(root: File, connectionId: String, roomId: String, actorId: String) {
    private val key = MessageDigest.getInstance("SHA-256").digest(listOf(connectionId, roomId, actorId).joinToString("\u0000").toByteArray()).joinToString("") { "%02x".format(it) }
    private val directory = File(root, "shared-composer/$key")
    private val manifest = File(directory, "draft.json")
    private fun media(id: String): File { require(Regex("[A-Za-z0-9_-]{1,100}").matches(id)); return File(directory, "$id.pending") }
    @Synchronized fun restore(): SharedDraftCheckpoint {
        if (!manifest.exists()) return SharedDraftCheckpoint()
        require(manifest.length() in 1..1_048_576) { "The saved shared draft could not be read." }
        val state = CompanionJson.decodeFromString<SharedDraftCheckpoint>(manifest.readText())
        require(state.files.size <= AttachmentPolicy.MAXIMUM_ITEMS && state.files.sumOf { it.size } <= SharedChatUiPolicy.MAX_TOTAL_BYTES)
        require((state.delivery == null) == (state.sendId == null)) { "The saved delivery identity is incomplete." }
        state.sendId?.let { require(Regex("[A-Za-z0-9_-]{1,128}").matches(it)) { "The saved delivery identity is invalid." } }
        if (state.delivery != null && !state.editedSinceDelivery) require(state.delivery.fileIDs == state.files.map { it.id } && state.delivery.replyTo == state.replyTo) { "The saved delivery snapshot is incomplete." }
        state.files.forEach { file -> require(file.size in 1..AttachmentPolicy.MAXIMUM_BUFFERED_FILE_BYTES.toLong() && media(file.id).length() == file.size) { "A saved shared attachment is missing. Discard the draft before sending again." } }
        return state
    }
    fun pending(state: SharedDraftCheckpoint): List<PendingMessageAttachment> = state.files.map {
        PendingMessageAttachment(it.id, name = it.name, mime = it.mime, kind = if (it.image) PendingMessageAttachment.Kind.IMAGE else PendingMessageAttachment.Kind.FILE, file = media(it.id))
    }
    fun records(items: List<PendingMessageAttachment>): List<SharedPendingFile> = items.map { SharedPendingFile(it.id, it.name, it.mime, it.bytes, it.kind == PendingMessageAttachment.Kind.IMAGE) }
    @Synchronized fun save(state: SharedDraftCheckpoint) {
        directory.mkdirs()
        val temporary = File(directory, "draft.json.tmp")
        FileOutputStream(temporary).use { stream -> stream.write(CompanionJson.encodeToString(state).toByteArray()); stream.fd.sync() }
        check(temporary.renameTo(manifest)) { "Couldn't save the shared draft. Nothing was sent." }
    }
    /** Copy before publishing to the composer; a picker cache is never a durable send checkpoint. */
    @Synchronized fun adopt(item: PendingMessageAttachment): PendingMessageAttachment {
        require(item.bytes in 1..AttachmentPolicy.MAXIMUM_BUFFERED_FILE_BYTES.toLong())
        directory.mkdirs()
        val target = media(item.id)
        val temporary = File(directory, "${item.id}.tmp")
        try {
            val source = item.file?.inputStream() ?: item.data.inputStream()
            source.use { input -> FileOutputStream(temporary).use { output ->
                val buffer = ByteArray(64 * 1024); var count = 0L
                while (true) { val size = input.read(buffer); if (size < 0) break; count += size; require(count <= AttachmentPolicy.MAXIMUM_BUFFERED_FILE_BYTES); output.write(buffer, 0, size) }
                require(count == item.bytes); output.fd.sync()
            } }
            check(temporary.renameTo(target))
            return PendingMessageAttachment(item.id, name = item.name, mime = item.mime, kind = item.kind, file = target)
        } finally { temporary.delete() }
    }
    @Synchronized fun remove(id: String) { media(id).delete() }
    @Synchronized fun discard() { directory.deleteRecursively() }
}
