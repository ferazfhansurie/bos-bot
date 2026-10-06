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

/** True when another home's stream mentions a room or member bot this home
 * has no listing for yet — a room it was just added to, or a bot that joined
 * one. Only a fresh GET /api/groups carries those (with `remoteBots`). */
export function remoteRoomNeedsListing(
  groups: readonly (RoomLike & { remoteBots?: Array<{ id: string }> })[],
  homeId: string,
  frame: ServerFrame,
): boolean {
  if (frame.kind !== "group") return false;
  const incoming = frame.group as { id?: unknown; memberIds?: unknown };
  if (typeof incoming?.id !== "string") return false;
  const known = groups.find((group) => group.id === incoming.id);
  if (!known) return true;
  if (known.home?.id !== homeId || !Array.isArray(known.remoteBots) || !Array.isArray(incoming.memberIds)) return false;
  const listed = new Set(known.remoteBots.map((bot) => bot.id));
  return incoming.memberIds.some((id) => typeof id === "string" && !listed.has(id));
}

type ListedRoom = RoomLike & {
  remoteBots?: unknown;
  avatarUrl?: string | null;
  name?: string;
  messages?: unknown;
  hasMore?: unknown;
};

/** What a periodic GET /api/groups adds to the store: rooms on another home
 * this client hasn't listed yet, whole, and for the ones it has only the
 * listing-owned fields that changed (profiles, photo, name, availability) —
 * never a transcript, which the live stream owns. Local rooms are skipped. */
export function remoteRoomListPatches<T extends ListedRoom>(known: readonly ListedRoom[], listed: readonly T[]): Array<T | (Partial<T> & { id: string })> {
  const byId = new Map(known.map((group) => [group.id, group]));
  const patches: Array<T | (Partial<T> & { id: string })> = [];
  for (const group of listed) {
    if (!group?.home) continue;
    const current = byId.get(group.id);
    if (!current) {
      patches.push(group);
      continue;
    }
    if (!current.home) continue;
    const patch: Partial<T> & { id: string } = { id: group.id } as Partial<T> & { id: string };
    let changed = false;
    for (const key of ["home", "remoteBots", "avatarUrl", "name"] as const) {
      if (!Object.hasOwn(group, key)) continue;
      if (JSON.stringify(group[key]) === JSON.stringify(current[key])) continue;
      (patch as Record<string, unknown>)[key] = group[key];
      changed = true;
    }
    if (changed) patches.push(patch);
  }
  return patches;
}
