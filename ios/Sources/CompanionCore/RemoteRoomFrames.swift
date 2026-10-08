import Foundation

/// Frames from another home's stream touch only the rooms this computer
/// joined there; that home's bots, inbox, notifications and screens are not
/// this computer's state, so everything else is dropped. A room frame keeps
/// the `home` this computer stamped on it, which the relayed room doesn't
/// carry. Mirrors the desktop's src/lib/remote-room-frames.ts.
public func remoteRoomFrame(rooms: [Room], homeId: String, frame: Frame) -> Frame? {
    let joined = rooms.filter { $0.home?.id == homeId }
    func inRoom(_ threadId: String) -> Bool {
        joined.contains { $0.threadId == threadId || ($0.tasks ?? []).contains { $0.threadId == threadId } }
    }
    switch frame {
    case let .message(threadId, _), let .messagePatch(threadId, _), let .thread(threadId, _):
        return inRoom(threadId) ? frame : nil
    case let .runtime(event):
        return inRoom(event.threadId) ? frame : nil
    case let .room(room):
        guard let known = joined.first(where: { $0.id == room.id }) else { return nil }
        var stamped = room
        stamped.home = known.home
        return .room(stamped)
    case let .roomDeleted(groupId):
        return joined.contains { $0.id == groupId } ? frame : nil
    default:
        return nil
    }
}

/// One stream per linked home, opened through any one of its rooms.
public func remoteRoomStreams(rooms: [Room]) -> [String: String] {
    var via: [String: String] = [:]
    for room in rooms {
        guard let home = room.home, via[home.id] == nil else { continue }
        via[home.id] = room.id
    }
    return via
}
