package com.openmausbot.companion.core

/** A relayed home can touch only the rooms this pairing has already joined. */
fun remoteRoomFrame(rooms: List<Room>, homeId: String, frame: Frame): Frame? {
    val joined = rooms.filter { it.home?.id == homeId }
    fun inRoom(threadId: String) = joined.any { room -> room.threadId == threadId || room.tasks.orEmpty().any { it.threadId == threadId } }
    return when (frame) {
        is Frame.Message, is Frame.MessagePatch, is Frame.Thread -> frame.takeIf { frame.threadId?.let(::inRoom) == true }
        is Frame.Runtime -> frame.takeIf { inRoom(frame.event.threadId) }
        is Frame.Room -> joined.firstOrNull { it.id == frame.room.id }?.let { Frame.Room(frame.room.copy(home = it.home)) }
        is Frame.RoomDeleted -> frame.takeIf { joined.any { it.id == frame.groupId } }
        else -> null
    }
}
fun remoteRoomStreams(rooms: List<Room>): Map<String, String> = buildMap {
    rooms.forEach { room -> room.home?.let { if (it.id !in this) put(it.id, room.id) } }
}
