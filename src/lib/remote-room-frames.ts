import type { ServerFrame } from "../../shared/wire";

interface RoomLike {
  id: string;
  threadId: string;
  tasks?: Array<{ threadId: string }>;
  home?: { id: string; name: string; available?: boolean };
}

/** Frames from another home's stream touch only the rooms this home joined
 * there; that home's bots, inbox, config and notifications are not this
 * home's state, so everything else is dropped. A room frame keeps the
 * `home` this home stamped on it, which the wire group doesn't carry. */
export function remoteRoomFrame(groups: readonly RoomLike[], homeId: string, frame: ServerFrame): ServerFrame | null {
  const rooms = groups.filter((group) => group.home?.id === homeId);
  const room = (id: string) => rooms.find((group) => group.id === id);
  const inRoom = (threadId: string) =>
    rooms.some((group) => group.threadId === threadId || group.tasks?.some((task) => task.threadId === threadId));
  switch (frame.kind) {
    case "message":
    case "message.patch":
    case "thread":
      return inRoom(frame.threadId) ? frame : null;
    case "runtime":
      return inRoom(frame.event.threadId) ? frame : null;
    case "group": {
      const known = room(frame.group.id);
      // SAFETY: the store reads frame.group as Partial<Group>, which has home.
      return known ? ({ ...frame, group: { ...frame.group, home: known.home } } as ServerFrame) : null;
    }
    case "group.deleted":
      return room(frame.groupId) ? frame : null;
    default:
      return null;
  }
}
