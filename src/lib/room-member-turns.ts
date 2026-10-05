// Which room members are working in one room thread right now, and since
// when. The server's activeBotIds is the room-wide truth (a member drops out
// the moment its provider turn ends or is stopped); the public runtime
// turn.started/turn.completed frames, which carry roomBotId, say which room
// thread each member is working in, and the room's activeMemberTurns snapshot
// says the same for turns whose start frame this renderer never saw (opened or
// reconnected mid-turn). A member shows only when one of those places it in
// this thread, so a member busy in another thread of the room, or in its own
// private thread, never appears here.
import { useSyncExternalStore } from "react";
import { roomMemberStreamKey } from "@/lib/runtime-stream";
import type { Message, RoomActiveMemberTurn } from "@/state/store";

export interface RoomMemberTurn {
  threadId: string;
  botId: string;
  turnId?: string;
  startedAt: number;
  /** its completion frame arrived; kept so a room frame sent before the
   * completion cannot bring the member back, until a newer turn starts */
  completed?: boolean;
}

export type RoomMemberTurns = ReadonlyMap<string, RoomMemberTurn>;

type RoomTurnEvent = { type: string; threadId: string; roomBotId?: string; turnId?: string; createdAt?: string };

export function applyRoomTurnEvent(turns: RoomMemberTurns, event: RoomTurnEvent, now = Date.now()): RoomMemberTurns {
  if (!event.roomBotId || (event.type !== "turn.started" && event.type !== "turn.completed")) return turns;
  const key = roomMemberStreamKey(event.threadId, event.roomBotId);
  const current = turns.get(key);
  const next = new Map(turns);
  if (event.type === "turn.started") {
    const at = event.createdAt ? Date.parse(event.createdAt) : NaN;
    next.set(key, { threadId: event.threadId, botId: event.roomBotId, turnId: event.turnId, startedAt: Number.isFinite(at) ? at : now });
    return next;
  }
  // a late completion from an older turn must not end the member's newer one
  if (current && (current.completed || (current.turnId && event.turnId && current.turnId !== event.turnId))) return turns;
  next.set(key, current
    ? { ...current, completed: true }
    // completion of a turn whose start was never seen still settles it
    : { threadId: event.threadId, botId: event.roomBotId, turnId: event.turnId, startedAt: now, completed: true });
  return next;
}

/** A room frame is authoritative: drop any running member it no longer counts
 * as working in that room, so a missed completion cannot leave a stale row.
 * Completed turns stay as they are. */
export function pruneRoomTurns(turns: RoomMemberTurns, threadIds: string[], activeBotIds: string[] | undefined): RoomMemberTurns {
  if (!activeBotIds) return turns;
  const threads = new Set(threadIds);
  let next: Map<string, RoomMemberTurn> | null = null;
  for (const [key, turn] of turns) {
    if (turn.completed || !threads.has(turn.threadId) || activeBotIds.includes(turn.botId)) continue;
    next ??= new Map(turns);
    next.delete(key);
  }
  return next ?? turns;
}

/** Whether a snapshot entry is a turn the renderer already saw finish. Equal
 * turn ids, or a start no later than the finished one, mean the frame predates
 * the completion; with neither fact the completion stands. */
function settledBy(entry: RoomActiveMemberTurn, done: RoomMemberTurn): boolean {
  if (entry.turnId && done.turnId) return entry.turnId === done.turnId;
  if (entry.startedAt == null) return true;
  return entry.startedAt <= done.startedAt;
}

export interface RoomPresenceInput {
  threadId: string;
  activeBotIds?: string[];
  /** the server's per-thread snapshot; absent on servers that predate it */
  activeMemberTurns?: RoomActiveMemberTurn[];
  turns: RoomMemberTurns;
  messages: Message[];
}

export interface RoomPresenceMember {
  botId: string;
  /** turn start, epoch ms; null when nothing reliable says when it began */
  since: number | null;
  /** this member's own tool step still in flight, if any */
  tool: Message | null;
}

export function roomPresenceMembers(input: RoomPresenceInput): RoomPresenceMember[] {
  const active = input.activeBotIds ?? [];
  const snapshot = new Map((input.activeMemberTurns ?? [])
    .filter((entry) => entry.threadId === input.threadId)
    .map((entry) => [entry.botId, entry]));
  const out: RoomPresenceMember[] = [];
  for (const botId of new Set([...active, ...snapshot.keys()])) {
    const own = input.turns.get(roomMemberStreamKey(input.threadId, botId));
    const entry = snapshot.get(botId);
    let since: number | null;
    if (own && !own.completed && active.includes(botId)) since = own.startedAt;
    // Opened or reconnected mid-turn: only the server's snapshot can say this
    // thread owns the turn; room-wide activeBotIds alone never does.
    else if (entry && !(own?.completed && settledBy(entry, own))) since = entry.startedAt ?? null;
    else continue;
    out.push({ botId, since, tool: inFlightTool(input.messages, botId, since) });
  }
  return out;
}

function inFlightTool(messages: Message[], botId: string, since: number | null): Message | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (since !== null && message.at < since) return null;
    if (message.from?.botId !== botId) continue;
    // only a step still running counts; a finished receipt is not activity
    return message.kind === "activity" && message.tool && message.tool.ok === undefined && !message.comm ? message : null;
  }
  return null;
}

// One renderer-wide record, fed by the store's live runtime frames.
let current: RoomMemberTurns = new Map();
const listeners = new Set<() => void>();
function publish(next: RoomMemberTurns) {
  if (next === current) return;
  current = next;
  for (const listener of listeners) listener();
}
export const roomMemberTurns = {
  event(event: RoomTurnEvent) { publish(applyRoomTurnEvent(current, event)); },
  room(threadIds: string[], activeBotIds: string[] | undefined) { publish(pruneRoomTurns(current, threadIds, activeBotIds)); },
  reset() { publish(new Map()); },
  get: () => current,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
};

export function useRoomMemberTurns(): RoomMemberTurns {
  return useSyncExternalStore(roomMemberTurns.subscribe, roomMemberTurns.get, roomMemberTurns.get);
}
