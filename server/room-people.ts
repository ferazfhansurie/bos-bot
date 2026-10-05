import { parseContactId } from "../shared/multiplayer.ts";
import type { WireGroup } from "../shared/wire.ts";
export function roomPeople(group: Pick<WireGroup, "peopleIds">, ownerId: string): string[] {
  return [...new Set([ownerId, ...(group.peopleIds ?? [])])];
}
/** Room messages and completed replies may push; owner-only workflow
 * notifications must never be forwarded to room guests. */
export function roomPushPeople(group: Pick<WireGroup, "peopleIds" | "notifications">, ownerId: string, canRead: (personId: string) => boolean, excludeId: string, notificationKind?: string): string[] {
  if (group.notifications === "muted" || notificationKind !== undefined && notificationKind !== "done") return [];
  return roomPeople(group, ownerId).filter(personId => personId !== excludeId && canRead(personId));
}
export function personCanReadRoom(group: Pick<WireGroup, "peopleIds" | "dm"> | undefined, actorId: string | null, ownerId: string): boolean {
  return !!group && !!actorId && (actorId === ownerId || !group.dm && roomPeople(group, ownerId).includes(actorId));
}
export function checkedRoomPeople(value: unknown, ownerId: string, known: ReadonlySet<string>): string[] {
  if (!Array.isArray(value) || value.length > 50 || new Set(value).size !== value.length || value.some(id => parseContactId(id)?.kind !== "person" || !known.has(id))) {
    throw Object.assign(new Error("peopleIds must contain distinct known people"), { status: 400 });
  }
  return [...new Set([ownerId, ...value])];
}
export function roomForPerson(group: WireGroup): WireGroup {
  const { cwd: _cwd, ...view } = group;
  return { ...view, tasks: view.tasks?.map(({ pinnedCwd: _pinnedCwd, ...task }) => task) };
}
