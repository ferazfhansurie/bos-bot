// Bot runs, approval cards and provisional stream text for the selected room
// (slices 3/4). Runs and cards are committed server state carried by ordered
// room events; cards only move forward by version. Stream text is provisional:
// it belongs to one attempt and fence generation, and disappears when the
// final commits, the run ends or the account loses the room.
import {
  ApprovalCardSchema,
  InvocationSchema,
  RunBindingSchema,
  type ApprovalCard,
  type CloudInvocation,
  type CloudMessage,
} from "../../shared/cloud-protocol/index";
import { z } from "zod";

export const TERMINAL_RUN_STATES: ReadonlySet<CloudInvocation["state"]> = new Set(["completed", "failed", "cancelled"]);

export type RunBinding = z.infer<typeof RunBindingSchema>;

export const StreamDeltaSchema = z.object({ ...RunBindingSchema.shape, delta_id: z.string().min(1), text: z.string() });
export type StreamDelta = z.infer<typeof StreamDeltaSchema>;

export interface ProvisionalStream {
  attempt: number;
  /** Decimal string; compared as BigInt, never as a JS number. */
  fence_gen: string;
  /** Applied delta ids; a redelivered delta never repeats text. */
  delta_ids: string[];
  text: string;
}

export interface RunProjection {
  runs: Record<string, CloudInvocation>;
  /** Keyed by approval_id. */
  cards: Record<string, ApprovalCard>;
  streams: Record<string, ProvisionalStream>;
  /** Invocations whose final reply is committed; late deltas for them are ignored. */
  finals: Record<string, true>;
}

export const EMPTY_RUNS: RunProjection = { runs: {}, cards: {}, streams: {}, finals: {} };

/** Finals are committed by the host as `invocation.<invocation_id>` operations under the bot's id. */
export function finalInvocationId(message: Pick<CloudMessage, "bot_id" | "client_operation_id">): string | null {
  if (!message.bot_id || !message.client_operation_id.startsWith("invocation.")) return null;
  return message.client_operation_id.slice("invocation.".length) || null;
}

/** -1, 0 or 1 comparing (attempt, fence_gen) bindings. */
export function compareBinding(a: { attempt: number; fence_gen: string }, b: { attempt: number; fence_gen: string }): number {
  if (a.attempt !== b.attempt) return a.attempt < b.attempt ? -1 : 1;
  const x = BigInt(a.fence_gen);
  const y = BigInt(b.fence_gen);
  return x === y ? 0 : x < y ? -1 : 1;
}

export const parseRun = (item: unknown): CloudInvocation | null => {
  const parsed = InvocationSchema.safeParse(item);
  return parsed.success ? parsed.data : null;
};

export const parseCard = (item: unknown): ApprovalCard | null => {
  const parsed = ApprovalCardSchema.safeParse(item);
  return parsed.success ? parsed.data : null;
};

/** Replace from a snapshot. Streams survive only for runs still active at the same binding. */
export function runsFromSnapshot(
  previous: RunProjection,
  snapshot: { active_runs: readonly CloudInvocation[]; cards: readonly ApprovalCard[]; messages: readonly CloudMessage[] },
  threadId: string,
): RunProjection {
  const runs: Record<string, CloudInvocation> = {};
  for (const run of snapshot.active_runs) if (run.thread_id === threadId) runs[run.invocation_id] = run;
  const cards: Record<string, ApprovalCard> = {};
  for (const card of snapshot.cards) if (card.thread_id === threadId) cards[card.approval_id] = card;
  const finals: Record<string, true> = { ...previous.finals };
  for (const message of snapshot.messages) {
    const id = finalInvocationId(message);
    if (id) finals[id] = true;
  }
  const streams: Record<string, ProvisionalStream> = {};
  for (const [id, stream] of Object.entries(previous.streams)) {
    const run = runs[id];
    if (run && !finals[id] && !TERMINAL_RUN_STATES.has(run.state) && compareBinding(run, stream) === 0) streams[id] = stream;
  }
  return { runs, cards, streams, finals };
}

function dropStaleStream(streams: Record<string, ProvisionalStream>, run: CloudInvocation): Record<string, ProvisionalStream> {
  const stream = streams[run.invocation_id];
  // A new attempt/generation or an ended run invalidates provisional text from the old one.
  if (!stream || (!TERMINAL_RUN_STATES.has(run.state) && compareBinding(run, stream) === 0)) return streams;
  const next = { ...streams };
  delete next[run.invocation_id];
  return next;
}

/** Room events arrive in commit order, so the latest run event replaces the run. */
export function applyRun(projection: RunProjection, run: CloudInvocation, threadId: string): RunProjection {
  if (run.thread_id !== threadId) return projection;
  return { ...projection, runs: { ...projection.runs, [run.invocation_id]: run }, streams: dropStaleStream(projection.streams, run) };
}

/** Partial updates from claimed/stop events; applied only to a known run at the same or a newer binding. */
export function patchRun(projection: RunProjection, binding: RunBinding, patch: Partial<CloudInvocation>): RunProjection {
  const current = projection.runs[binding.invocation_id];
  if (!current || compareBinding(binding, current) < 0) return projection;
  const run = { ...current, ...patch, attempt: binding.attempt, fence_gen: binding.fence_gen };
  return { ...projection, runs: { ...projection.runs, [run.invocation_id]: run }, streams: dropStaleStream(projection.streams, run) };
}

export function applyCard(projection: RunProjection, card: ApprovalCard, threadId: string): RunProjection {
  if (card.thread_id !== threadId) return projection;
  const current = projection.cards[card.approval_id];
  // Every change bumps the version: one valid decision wins and never reverts to pending.
  if (current && current.version >= card.version) return projection;
  return { ...projection, cards: { ...projection.cards, [card.approval_id]: card } };
}

export function applyHostPresence(projection: RunProjection, hostId: string, online: boolean): RunProjection {
  let runs = projection.runs;
  for (const run of Object.values(projection.runs)) {
    if (run.host_id === hostId && run.host_online !== online) runs = { ...runs, [run.invocation_id]: { ...run, host_online: online } };
  }
  return runs === projection.runs ? projection : { ...projection, runs };
}

/** The committed final for an invocation ends its provisional text for good. */
export function applyFinal(projection: RunProjection, invocationId: string, messageId?: string): RunProjection {
  const streams = { ...projection.streams };
  delete streams[invocationId];
  const run = projection.runs[invocationId];
  const runs = run ? { ...projection.runs, [invocationId]: { ...run, state: "completed" as const, result_message_id: messageId ?? run.result_message_id } } : projection.runs;
  return { ...projection, runs, streams, finals: { ...projection.finals, [invocationId]: true } };
}

export function applyDelta(projection: RunProjection, delta: StreamDelta): RunProjection {
  if (projection.finals[delta.invocation_id]) return projection;
  const run = projection.runs[delta.invocation_id];
  if (run && (TERMINAL_RUN_STATES.has(run.state) || compareBinding(delta, run) < 0)) return projection;
  const current = projection.streams[delta.invocation_id];
  // Older attempts and stale fence generations never touch newer text.
  if (current && compareBinding(delta, current) < 0) return projection;
  let next: ProvisionalStream;
  if (!current || compareBinding(delta, current) > 0) next = { attempt: delta.attempt, fence_gen: delta.fence_gen, delta_ids: [delta.delta_id], text: delta.text };
  else if (current.delta_ids.includes(delta.delta_id)) return projection;
  else next = { ...current, delta_ids: [...current.delta_ids, delta.delta_id], text: current.text + delta.text };
  return { ...projection, streams: { ...projection.streams, [delta.invocation_id]: next } };
}

export type RunView = { run: CloudInvocation; stream: ProvisionalStream | null; card: ApprovalCard | null; label: string };

/** Runs to show under the thread: everything without a committed reply, including failures. */
export function visibleRuns(projection: RunProjection, now: number): RunView[] {
  const cards = Object.values(projection.cards);
  return Object.values(projection.runs)
    .filter((run) => !projection.finals[run.invocation_id] && run.state !== "completed")
    .map((run) => ({
      run,
      stream: projection.streams[run.invocation_id] ?? null,
      card: cards.filter((card) => card.invocation_id === run.invocation_id).sort((a, b) => b.version - a.version)[0] ?? null,
      label: runLabel(run, now),
    }));
}

export function runLabel(run: CloudInvocation, now: number): string {
  if (run.state === "queued" && run.host_online === false) {
    const expires = Date.parse(run.queued_expires_at);
    const hours = Number.isFinite(expires) ? Math.max(0, Math.ceil((expires - now) / 3_600_000)) : null;
    return hours === null ? "host offline, waiting" : `host offline, waits ${hours}h then gives up`;
  }
  if (run.stop_requested && !run.stopped_observed && !TERMINAL_RUN_STATES.has(run.state)) return "stopping";
  switch (run.state) {
    case "queued":
      return "queued";
    case "leased":
      return "starting";
    case "running":
      return run.host_online === false ? "host went offline, waiting to recover" : "replying";
    case "waiting_for_human":
      return "needs a decision";
    case "held":
      return run.stop_requested ? "stopping" : "on hold: the host lost this run";
    case "completed":
      return "done";
    case "failed":
      // The only server-side failure without a host is the 24h offline queue expiry.
      return run.host_id === null ? "didn't start: host was offline for 24h" : "failed";
    case "cancelled":
      return "stopped";
  }
}

/** Pending cards this account can still act on: view and decide are separate, and only the bound actor decides. */
export function decidable(card: ApprovalCard, accountId: string, now: number): boolean {
  return card.status === "pending" && card.can_decide && card.actor_id === accountId && Date.parse(card.expires_at) > now;
}

export type RoomBot = { bot_id: string; name: string; host_online: boolean | null };

/**
 * Bots seen in this thread (runs and committed replies). The room wire has no
 * bot directory yet, so the id doubles as the name; host_online comes from the
 * newest run that reports it.
 */
export function roomBots(projection: RunProjection, messages: readonly CloudMessage[]): RoomBot[] {
  const bots = new Map<string, RoomBot>();
  for (const message of messages) if (message.bot_id && !bots.has(message.bot_id)) bots.set(message.bot_id, { bot_id: message.bot_id, name: message.bot_id, host_online: null });
  for (const run of Object.values(projection.runs)) {
    const known = bots.get(run.bot_id);
    bots.set(run.bot_id, { bot_id: run.bot_id, name: run.bot_id, host_online: run.host_online ?? known?.host_online ?? null });
  }
  return [...bots.values()];
}
