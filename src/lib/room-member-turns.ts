// Which room members are working in one room thread right now, and since
// when. The server's activeBotIds is the room-wide truth (a member drops out
// the moment its provider turn ends or is stopped); the public runtime
// turn.started/turn.completed frames, which carry roomBotId, say which room
// thread each member is working in. A member shows only when both agree, so a
// member busy in another thread of the room, or in its own private thread,
// never appears here.
import { useSyncExternalStore } from "react";
import { roomMemberStreamKey } from "@/lib/runtime-stream";
import type { Message } from "@/state/store";

export interface RoomMemberTurn {
  threadId: string;
  botId: string;
  turnId?: string;
  startedAt: number;
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
  if (!current || (current.turnId && event.turnId && current.turnId !== event.turnId)) return turns;
  next.delete(key);
  return next;
}

/** A room frame is authoritative: drop any member it no longer counts as
 * working in that room, so a missed completion cannot leave a stale row. */
export function pruneRoomTurns(turns: RoomMemberTurns, threadIds: string[], activeBotIds: string[] | undefined): RoomMemberTurns {
  if (!activeBotIds) return turns;
  const threads = new Set(threadIds);
  let next: Map<string, RoomMemberTurn> | null = null;
  for (const [key, turn] of turns) {
    if (!threads.has(turn.threadId) || activeBotIds.includes(turn.botId)) continue;
    next ??= new Map(turns);
    next.delete(key);
  }
  return next ?? turns;
}

export interface RoomPresenceInput {
  threadId: string;
  activeBotIds?: string[];
  busyBotId?: string | null;
  turnStartedAt?: number | null;
  /** other room threads the server reports as running */
  otherThreadRunning: boolean;
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
  // servers without activeBotIds only know the one speaker
  const active = input.activeBotIds ?? (input.busyBotId ? [input.busyBotId] : []);
  const out: RoomPresenceMember[] = [];
  for (const botId of active) {
    const own = input.turns.get(roomMemberStreamKey(input.threadId, botId));
    let since: number | null;
    if (own) since = own.startedAt;
    else {
      // Opened mid-turn: no start frame was seen. The member is still known
      // to be in this thread when it is not tracked in any other thread and
      // no other room thread is running; otherwise it stays out.
      const elsewhere = [...input.turns.values()].some((turn) => turn.botId === botId);
      if (elsewhere || input.otherThreadRunning) continue;
      since = botId === input.busyBotId ? input.turnStartedAt ?? null : null;
    }
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
