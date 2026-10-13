package com.openmausbot.companion.core

import java.util.Base64
import java.util.UUID
import kotlinx.serialization.Serializable

@Serializable data class SharedContact(val id: String, val name: String, val kind: String, val homeId: String? = null,
    val title: String? = null, val color: String? = null, val mascotEyes: String? = null, val mascotBody: String? = null,
    val avatar: String? = null, val avatarUrl: String? = null, val avatarCrop: AvatarCrop? = null,
    val ownerName: String? = null, val remote: Boolean? = null)
@Serializable data class SharedRoomSummary(val id: String, val homeId: String, val name: String, val memberIds: List<String>,
    val createdAt: Double, val kind: String? = null, val lastActivity: Double? = null, val preview: String? = null,
    val createdBy: String? = null, val revision: Int? = null, val unreadCount: Int? = null,
    val readSequence: Int? = null, val notifications: String? = null) {
    val isGroup: Boolean get() = kind == "group" || (kind == null && memberIds.size > 2)
    fun displayName(contacts: List<SharedContact>, selfID: String): String {
        val others = memberIds.filter { it != selfID }.mapNotNull { id -> contacts.firstOrNull { it.id == id }?.name }
        if (!isGroup && memberIds.size == 2 && others.isNotEmpty()) return others.first()
        val title = name.trim()
        return if ((title.isEmpty() || title == "Group chat") && others.isNotEmpty()) others.joinToString(", ") else title.ifEmpty { "Group chat" }
    }
}
@Serializable data class SharedActor(val homeId: String, val kind: String, val localId: String) {
    val id: String get() = "$homeId:$kind:$localId"
}
@Serializable data class SharedChatMessage(val id: String, val roomId: String, val sequence: Int, val actor: SharedActor,
    val text: String, val at: Double, val sendId: String, val responseTo: String? = null, val replyTo: String? = null,
    val editedAt: Double? = null, val deletedAt: Double? = null, val reactions: Map<String, List<String>>? = null,
    val pinnedBy: String? = null, val attachments: List<SharedAttachment>? = null, val kind: String? = null,
    val tool: SharedTool? = null) {
    val isActivity: Boolean get() = kind == "activity"
    val replyReference: String? get() = if (deletedAt != null) null else replyTo ?: responseTo.takeIf { actor.kind == "bot" }
    val activityLabel: String? get() {
        if (tool?.name in setOf("working", "still working") && tool?.ok != null) {
            if (tool.ok == true) return "Completed"
            if (tool.spoken != null && !Regex("is (still )?working on this$").containsMatchIn(tool.spoken)) return tool.spoken
            return "Stopped"
        }
        return listOfNotNull(tool?.spoken, text, tool?.name).map(String::trim).firstOrNull(String::isNotEmpty)
    }
    private val activityKey: String? get() = if (actor.kind == "bot" && isActivity && sendId.startsWith("activity-"))
        "$roomId:${actor.id}:${responseTo.orEmpty()}:${sendId.replace(Regex("-(start|ok|failed)$"), "")}" else null
    companion object {
        fun visible(messages: List<SharedChatMessage>): List<SharedChatMessage> {
            val latest = mutableMapOf<String, Int>()
            messages.forEachIndexed { index, message -> message.activityKey?.let { latest[it] = index } }
            return messages.filterIndexed { index, message -> message.activityKey?.let { latest[it] == index } ?: true }
        }
    }
}
@Serializable data class SharedTool(val name: String, val ok: Boolean? = null, val spoken: String? = null)
@Serializable data class SharedAttachment(val id: String, val name: String, val mime: String, val size: Int)
@Serializable data class SharedAttachmentData(val attachment: SharedAttachment, val data: String) {
    fun bytes(): ByteArray {
        if (attachment.size !in 1..AttachmentPolicy.MAXIMUM_BUFFERED_FILE_BYTES || data.length > 35_000_000) throw APIError.Transport("The shared attachment is too large.")
        val bytes = try { Base64.getDecoder().decode(data) } catch (_: IllegalArgumentException) { throw APIError.Transport("The shared attachment could not be read.") }
        if (bytes.size != attachment.size) throw APIError.Transport("The shared attachment size did not match.")
        return bytes
    }
}
@Serializable data class SharedFile(val attachment: SharedAttachment, val messageId: String, val sequence: Int, val actor: SharedActor, val at: Double) {
    val id: String get() = "$messageId:${attachment.id}"
}
@Serializable data class SharedFilesResponse(val files: List<SharedFile>, val hasMore: Boolean, val before: Int? = null)
@Serializable data class SharedSearchResponse(val messages: List<SharedChatMessage>, val hasMore: Boolean, val before: Int? = null)
@Serializable data class SharedMessagesResponse(val messages: List<SharedChatMessage>, val changes: List<SharedChatMessage>? = null,
    val version: Int? = null, val hasMore: Boolean? = null, val typing: List<String>? = null)
@Serializable data class SharedConversationPreferences(val readSequence: Int, val notifications: String,
    val replyMode: String? = null, val replyBotId: String? = null, val replyBotIds: List<String>? = null)
@Serializable data class SharedEligibleBot(val id: String, val name: String, val color: String? = null,
    val mascotEyes: String? = null, val mascotBody: String? = null, val ownerName: String? = null, val availability: String? = null) {
    val availabilityLabel: String? get() = when (availability) { "offline" -> "Host offline"; "update-required" -> "Update required"; "reconnect-required" -> "Reconnect required"; else -> null }
    companion object {
        fun matching(bots: List<SharedEligibleBot>, query: String): List<SharedEligibleBot> = bots.filter {
            query.isBlank() || it.name.contains(query.trim(), true) || it.ownerName?.contains(query.trim(), true) == true
        }
    }
}
data class SharedMentionChoice(val id: String, val name: String, val kind: String, val ownerName: String?, val availabilityLabel: String?, val label: String = name) {
    val detail: String get() = if (kind == "person") "Person" else ownerName?.let { "$it’s bot" } ?: "Bot"
    private val qualifier: String get() = if (kind == "person") "person" else ownerName?.takeIf(String::isNotEmpty) ?: "bot"
    companion object {
        fun choices(contacts: List<SharedContact>, memberIDs: List<String>, bots: List<SharedEligibleBot>): List<SharedMentionChoice> {
            val roster = contacts.filter { it.kind == "person" && it.id in memberIDs }.map {
                SharedMentionChoice(it.id, it.name, "person", null, null)
            } + bots.map { SharedMentionChoice(it.id, it.name, "bot", it.ownerName, it.availabilityLabel) }
            return roster.map { item ->
                val same = roster.filter { it.name.equals(item.name, true) }
                if (same.size <= 1) item else item.copy(label = item.name + " · " + item.qualifier +
                    if (same.count { it.qualifier.equals(item.qualifier, true) } > 1) " · " + item.id else "")
            }
        }
        fun matching(choices: List<SharedMentionChoice>, query: String): List<SharedMentionChoice> = choices.filter {
            query.isBlank() || it.label.contains(query.trim(), true) || it.detail.contains(query.trim(), true)
        }
    }
}
@Serializable data class SharedBotRequest(val id: String, val roomId: String, val sourceId: String, val requesterId: String,
    val botId: String, val botName: String, val ownerId: String, val ownerName: String, val state: String,
    val createdAt: Double, val updatedAt: Double, val sourceSequence: Int? = null, val resultId: String? = null,
    val resultSequence: Int? = null, val explanation: String? = null) {
    val isActive: Boolean get() = state in setOf("accepted", "queued", "working", "waiting-approval")
    fun canCancel(actorId: String): Boolean = isActive && (requesterId == actorId || ownerId == actorId)
    val stateLabel: String get() = when (state) {
        "accepted" -> "Accepted"; "queued" -> "Queued"; "working" -> "Working"; "waiting-approval" -> "Waiting for owner"
        "completed" -> "Completed"; "failed" -> "Failed"; "offline" -> "Unavailable"; "cancelled" -> "Stopped"; else -> "Outcome unknown"
    }
}
@Serializable data class SharedRequestsResponse(val requests: List<SharedBotRequest>, val hasMore: Boolean, val before: Int? = null)
data class SharedRoster(val me: SharedMe, val contacts: List<SharedContact>, val rooms: List<SharedRoomSummary>)
@Serializable data class SharedSendDraft(val text: String, val fileIDs: List<String>, val replyTo: String?) {
    fun sendID(retrying: SharedSendDraft?, previousID: String?): String = if (this == retrying) previousID ?: UUID.randomUUID().toString() else UUID.randomUUID().toString()
}
@Serializable internal data class SharedContactsResponse(val contacts: List<SharedContact>)
@Serializable internal data class SharedRoomsResponse(val rooms: List<SharedRoomSummary>)
@Serializable internal data class SharedRoomResponse(val room: SharedRoomSummary)
@Serializable internal data class SharedMessageResponse(val message: SharedChatMessage)
@Serializable internal data class SharedAttachmentResponse(val attachment: SharedAttachment)
@Serializable internal data class SharedEligibleBotsResponse(val bots: List<SharedEligibleBot>)
@Serializable internal data class SharedRequestResponse(val request: SharedBotRequest)

object SharedAttachmentPolicy {
    const val MAXIMUM_TOTAL_BYTES = 100 * 1024 * 1024
    val supportedMimes = setOf("image/png", "image/jpeg", "image/webp", "image/gif", "application/pdf", "text/plain", "text/csv", "text/markdown", "text/tab-separated-values", "application/json", "audio/mpeg", "audio/mp4", "audio/wav", "video/mp4")
    fun validate(attachments: List<SharedAttachment>) {
        if (attachments.size > AttachmentPolicy.MAXIMUM_ITEMS || attachments.map { it.id }.distinct().size != attachments.size ||
            attachments.sumOf { it.size.toLong() } > MAXIMUM_TOTAL_BYTES || attachments.any {
                it.id.isEmpty() || it.id.any { char -> !char.isLetterOrDigit() && char != '-' && char != '_' } ||
                !validName(it.name) || it.mime !in supportedMimes || it.size <= 0 || it.size > limit(it.mime)
            }) throw APIError.Transport("Choose up to 32 supported shared files under 100 MB together.")
    }
    fun validName(name: String): Boolean = name.isNotBlank() && name.length <= 255 && name.none { it == '/' || it == '\\' || it.isISOControl() }
    fun limit(mime: String): Int = if (mime.startsWith("image/")) AttachmentPolicy.MAXIMUM_IMAGE_BYTES else AttachmentPolicy.MAXIMUM_BUFFERED_FILE_BYTES
}
