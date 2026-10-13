package com.openmausbot.companion.core
import kotlinx.serialization.Serializable
@Serializable data class RoomPerson(val id: String, val name: String, val homeId: String, val homeName: String? = null,
    val avatar: String? = null, val color: String? = null)
@Serializable data class RoomInvite(val url: String, val expiresAt: Double? = null)
@Serializable internal data class RoomBotGrants(val botIds: List<String>)
@Serializable data class RoomMemberBot(val id: String, val name: String? = null, val title: String? = null,
    val color: String? = null, val mascotBody: String? = null, val mascotEyes: String? = null,
    val avatarUrl: String? = null, val avatarCrop: AvatarCrop? = null, val remote: BotRemote? = null)
val Room.ownerPersonId: String? get() = peopleIds?.firstOrNull() ?: people?.firstOrNull()?.id
val Room.hasGuests: Boolean get() = (peopleIds?.size ?: people?.size ?: 0) > 1
fun Room.replyMode(botId: String): String = memberReplyModes?.get(botId)?.takeIf { it in setOf("always", "mentions") }
    ?: if (defaultResponder.kind == "everyone" || (defaultResponder.kind == "member" && defaultResponder.botId == botId)) "always" else "mentions"
