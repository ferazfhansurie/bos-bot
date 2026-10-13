package com.openmausbot.companion.core

import kotlinx.serialization.Serializable

@Serializable data class VoiceRing(
    val ringId: String, val botId: String, val threadId: String? = null,
    val reason: String = "", val inApp: Boolean = false,
    /** App-stamped pairing identity; never trust a wire value for routing. */
    val connectionId: String? = null,
    @kotlinx.serialization.Transient val runtimeIdentity: Any? = null,
)
@Serializable data class MessageOrigin(val kind: String = "voice_call", val callId: String, val job: String? = null)
data class VoiceReply(val id: String, val text: String, val at: Double)

/** Only the nearest user ancestor owns a settled bot reply's voice call. */
fun landedVoiceReplies(messages: List<Message>, callId: String, since: Double, busy: Boolean): List<VoiceReply> {
    val byId = messages.associateBy(Message::id)
    fun fromCall(message: Message): Boolean {
        var current: Message? = message
        val visited = mutableSetOf<String>()
        while (current != null && visited.add(current.id)) {
            if (current.role == Message.Role.USER) return current.origin?.let { it.kind == "voice_call" && it.callId == callId } == true
            current = current.parentId?.let(byId::get)
        }
        return false
    }
    return messages.filter { it.role == Message.Role.BOT && it.kind == Message.Kind.TEXT && it.at >= since &&
        !it.text.isNullOrBlank() && (it.turnTerminal == true || !busy) && fromCall(it) }
        .map { VoiceReply(it.id, it.text!!, it.at) }
}
