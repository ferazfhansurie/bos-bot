// Bot runs, approval cards and provisional stream text for the selected room
// (slices 3/4). Runs and cards are committed server state and only move
// forward by revision/version. Stream text is provisional: it belongs to one
// attempt and fence generation, and disappears when the final commits, the
// run ends or the account loses the room.
import {
  CardSchema,
  RoomBotSchema,
  RunSchema,
  TERMINAL_RUN_STATES,
  type CloudCard,
  type CloudRun,
  type RoomBot,
  type StreamDeltaFrame,
} from "../../shared/cloud-run-draft";

export interface ProvisionalStream {
  attempt: number;
  fence_gen: number;
  /** Last applied delta; deltas apply strictly in order. */
  seq: number;
  text: string;
  /** A delta went missing; the text stops growing until the final replaces it. */
  gap: boolean;
}

export interface RunProjection {
  runs: Record<string, CloudRun>;
  cards: Record<string, CloudCard>;
  bots: RoomBot[];
  streams: Record<string, ProvisionalStream>;
  /** Invocations whose final reply is committed; late deltas for them are ignored. */
  finals: Record<string, true>;
}

export const EMPTY_RUNS: RunProjection = { runs: {}, cards: {}, bots: [], streams: {}, finals: {} };

function parseAll<T>(items: readonly unknown[] | undefined, parse: (item: unknown) => T | null): T[] {
  return (items ?? []).map(parse).filter((item): item is T => item !== null);
}

export const parseRun = (item: unknown): CloudRun | null => {
  const parsed = RunSchema.safeParse(item);
  return parsed.success ? parsed.data : null;
};

export const parseCard = (item: unknown): CloudCard | null => {
  const parsed = CardSchema.safeParse(item);
  return parsed.success ? parsed.data : null;
};

export const parseBot = (item: unknown): RoomBot | null => {
  const parsed = RoomBotSchema.safeParse(item);
  return parsed.success ? parsed.data : null;
};

/** Replace from a snapshot. Streams survive only for runs that are still active at the same attempt. */
export function runsFromSnapshot(
  previous: RunProjection,
  snapshot: { active_runs: readonly unknown[]; cards: readonly unknown[]; bots?: readonly unknown[]; messages: ReadonlyArray<{ invocation_id?: string | null }> },
  threadId: string,
): RunProjection {
  const runs: Record<string, CloudRun> = {};
  for (const run of parseAll(snapshot.active_runs, parseRun)) if (run.thread_id === threadId) runs[run.invocation_id] = run;
  const cards: Record<string, CloudCard> = {};
  for (const card of parseAll(snapshot.cards, parseCard)) if (card.thread_id === threadId) cards[card.card_id] = card;
  const finals: Record<string, true> = { ...previous.finals };
  for (const message of snapshot.messages) if (message.invocation_id) finals[message.invocation_id] = true;
  const streams: Record<string, ProvisionalStream> = {};
  for (const [id, stream] of Object.entries(previous.streams)) {
    const run = runs[id];
    if (run && !finals[id] && !TERMINAL_RUN_STATES.has(run.state) && run.attempt === stream.attempt) streams[id] = stream;
  }
  return { runs, cards, bots: snapshot.bots ? parseAll(snapshot.bots, parseBot) : previous.bots, streams, finals };
}

export function applyRun(projection: RunProjection, run: CloudRun, threadId: string): RunProjection {
  if (run.thread_id !== threadId) return projection;
  const current = projection.runs[run.invocation_id];
  if (current && current.revision >= run.revision) return projection;
  const streams = { ...projection.streams };
  const stream = streams[run.invocation_id];
  // A new attempt or an ended run invalidates provisional text from the old one.
  if (stream && (TERMINAL_RUN_STATES.has(run.state) || run.attempt !== stream.attempt)) delete streams[run.invocation_id];
  return { ...projection, runs: { ...projection.runs, [run.invocation_id]: run }, streams };
}

export function applyCard(projection: RunProjection, card: CloudCard, threadId: string): RunProjection {
  if (card.thread_id !== threadId) return projection;
  const current = projection.cards[card.card_id];
  // One valid decision wins: a decided or newer card never goes back to pending.
  if (current && (current.version > card.version || (current.version === card.version && current.state !== "pending"))) return projection;
  return { ...projection, cards: { ...projection.cards, [card.card_id]: card } };
}

export function applyHostStatus(projection: RunProjection, botId: string, online: boolean): RunProjection {
  const bots = projection.bots.map((bot) => (bot.bot_id === botId && bot.host_online !== online ? { ...bot, host_online: online } : bot));
  let runs = projection.runs;
  for (const run of Object.values(projection.runs)) {
    if (run.bot_id === botId && run.host_online !== online) runs = { ...runs, [run.invocation_id]: { ...run, host_online: online } };
  }
  return { ...projection, bots, runs };
}

/** The committed final for an invocation ends its provisional text for good. */
export function applyFinal(projection: RunProjection, invocationId: string): RunProjection {
  if (projection.finals[invocationId] && !projection.streams[invocationId]) return projection;
  const streams = { ...projection.streams };
  delete streams[invocationId];
  return { ...projection, streams, finals: { ...projection.finals, [invocationId]: true } };
}

export function applyDelta(projection: RunProjection, frame: StreamDeltaFrame, threadId: string): RunProjection {
  if (frame.thread_id !== threadId || projection.finals[frame.invocation_id]) return projection;
  const run = projection.runs[frame.invocation_id];
  if (run && (TERMINAL_RUN_STATES.has(run.state) || frame.attempt < run.attempt)) return projection;
  const current = projection.streams[frame.invocation_id];
  // Older attempts and stale fence generations never touch newer text.
  if (current && (frame.attempt < current.attempt || (frame.attempt === current.attempt && frame.fence_gen < current.fence_gen))) return projection;
  const fresh = !current || frame.attempt > current.attempt || frame.fence_gen > current.fence_gen;
  let next: ProvisionalStream;
  if (fresh) next = frame.seq === 0 ? { attempt: frame.attempt, fence_gen: frame.fence_gen, seq: 0, text: frame.text, gap: false } : { attempt: frame.attempt, fence_gen: frame.fence_gen, seq: frame.seq, text: "", gap: true };
  else if (frame.seq <= current.seq) return projection;
  else if (current.gap || frame.seq !== current.seq + 1) next = { ...current, seq: frame.seq, gap: true };
  else next = { ...current, seq: frame.seq, text: current.text + frame.text };
  return { ...projection, streams: { ...projection.streams, [frame.invocation_id]: next } };
}

export type RunView = { run: CloudRun; stream: ProvisionalStream | null; card: CloudCard | null; label: string };

/** Runs to show under the thread: active ones, plus failures/cancellations that produced no reply. */
export function visibleRuns(projection: RunProjection, now: number): RunView[] {
  return Object.values(projection.runs)
    .filter((run) => !projection.finals[run.invocation_id] && run.state !== "completed")
    .map((run) => ({
      run,
      stream: projection.streams[run.invocation_id] ?? null,
      card: run.card_id ? projection.cards[run.card_id] ?? null : null,
      label: runLabel(run, now),
    }));
}

export function runLabel(run: CloudRun, now: number): string {
  if (run.state === "queued" && !run.host_online) {
    const expires = run.queued_expires_at ? Date.parse(run.queued_expires_at) : NaN;
    const hours = Number.isFinite(expires) ? Math.max(0, Math.ceil((expires - now) / 3_600_000)) : null;
    return hours === null ? "host offline, waiting" : `host offline, waits ${hours}h then gives up`;
  }
  if (run.stop_requested && !TERMINAL_RUN_STATES.has(run.state)) return "stopping";
  switch (run.state) {
    case "queued":
      return "queued";
    case "leased":
      return "starting";
    case "running":
      return run.host_online ? "replying" : "host went offline, waiting to recover";
    case "waiting_for_human":
      return "needs a decision";
    case "held":
      return "on hold";
    case "completed":
      return "done";
    case "failed":
      return run.failure === "queued_expired" ? "didn't start: host was offline for 24h" : `failed${run.failure ? `: ${run.failure.replace(/_/g, " ")}` : ""}`;
    case "cancelled":
      return "stopped";
  }
}

/** Pending cards this account can still act on. */
export function decidable(card: CloudCard, now: number): boolean {
  return card.state === "pending" && card.can_decide && Date.parse(card.expires_at) > now;
}
