// Streamed-token handling for the SSE broadcast in index.ts. Its own file
// for the same reason as ./sse-fanout.ts: index.ts starts the real server on
// import, so nothing in it can be unit tested directly.
//
// A provider can emit a content.delta per token — 30 a second per running
// thread. Sending each as its own frame made every client fold one frame per
// token, and numbering each one filled the 500-slot replay buffer in ~17s of
// one streaming reply, so a phone that unlocked any later than that fell back
// to a full hydrate. Two fixes live here: deltas are merged into ~50ms
// chunks before they are numbered, and the chunks are kept apart from the
// durable replay buffer, only for as long as the reply they belong to is
// still being typed.

type Payload = Record<string, unknown>;
type DeltaEvent = Record<string, unknown> & { type: "content.delta"; threadId: string; delta: string };

export const DELTA_COALESCE_MS = 50;

function deltaEvent(payload: Payload): DeltaEvent | null {
  if (payload.kind !== "runtime") return null;
  const event = payload.event as Record<string, unknown> | undefined;
  if (!event || event.type !== "content.delta") return null;
  if (typeof event.threadId !== "string" || typeof event.delta !== "string") return null;
  return event as DeltaEvent;
}

export const isDeltaFrame = (payload: Payload) => deltaEvent(payload) !== null;

/** Merges content.delta frames per thread, turn, item and stream kind, and
 * hands each merged frame to `emit` once its window closes. Anything else
 * must call `flush()` first, so a turn's end or its settled message is never
 * numbered ahead of the text that preceded it. */
export class DeltaCoalescer {
  private pending = new Map<string, { event: DeltaEvent; parts: string[] }>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly emit: (payload: Payload) => void;
  private readonly windowMs: number;

  constructor(emit: (payload: Payload) => void, windowMs = DELTA_COALESCE_MS) {
    this.emit = emit;
    this.windowMs = windowMs;
  }

  /** True when the frame was a delta and is now waiting to be merged. */
  offer(payload: Payload): boolean {
    const event = deltaEvent(payload);
    if (!event) return false;
    const key = [event.threadId, event.turnId ?? "", event.itemId ?? "", event.streamKind ?? ""].join("\u0000");
    const entry = this.pending.get(key);
    if (entry) entry.parts.push(event.delta);
    else this.pending.set(key, { event, parts: [event.delta] });
    this.timer ??= setTimeout(() => this.flush(), this.windowMs);
    return true;
  }

  /** Emit everything waiting, in the order each stream first arrived. */
  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.pending.size === 0) return;
    const batch = Array.from(this.pending.values());
    this.pending.clear();
    for (const { event, parts } of batch) {
      if (parts.length === 1) {
        this.emit({ kind: "runtime", event });
        continue;
      }
      // The first chunk's id and timestamp stand for the merged one. A raw
      // provider payload describes one chunk, not the merge, so it is dropped.
      const { raw: _raw, ...rest } = event;
      this.emit({ kind: "runtime", event: { ...rest, delta: parts.join("") } });
    }
  }
}

export interface ReplayEntry { seq: number; kind: string; frame: string | null; clientFrame: string | null }

/** Delta frames for replies still being typed, per thread, outside the
 * durable replay buffer. A thread's entries are dropped the moment its reply
 * settles — the settled message or the turn's end is durable and carries
 * everything they said — so they never crowd out frames that matter. */
export class LiveDeltaReplay {
  private threads = new Map<string, { entries: ReplayEntry[]; droppedThrough: number }>();
  private readonly maxPerThread: number;

  constructor(maxPerThread = 2_000) {
    this.maxPerThread = maxPerThread;
  }

  add(threadId: string, entry: ReplayEntry) {
    let thread = this.threads.get(threadId);
    if (!thread) this.threads.set(threadId, (thread = { entries: [], droppedThrough: 0 }));
    thread.entries.push(entry);
    if (thread.entries.length > this.maxPerThread) thread.droppedThrough = thread.entries.shift()!.seq;
  }

  /** Forget a thread's live text when a frame ends or supersedes it. Mirrors
   * the clients' own rule for clearing the typed-so-far bubble. */
  settle(payload: Payload) {
    const threadId = settledThread(payload);
    if (threadId) this.threads.delete(threadId);
  }

  /** Whether every delta after `since` is still here. False only when a
   * reply ran so long its own early chunks were dropped. */
  covers(since: number): boolean {
    for (const thread of this.threads.values()) if (since < thread.droppedThrough) return false;
    return true;
  }

  after(since: number): ReplayEntry[] {
    const out: ReplayEntry[] = [];
    for (const thread of this.threads.values()) for (const entry of thread.entries) if (entry.seq > since) out.push(entry);
    return out;
  }
}

function settledThread(payload: Payload): string | null {
  if (payload.kind === "runtime") {
    const event = payload.event as Record<string, unknown> | undefined;
    const type = event?.type;
    if (typeof event?.threadId !== "string") return null;
    if (type === "turn.completed" || type === "turn.failed" || type === "turn.aborted") return event.threadId;
    if (type === "item.completed" && event.itemType === "assistant_text") return event.threadId;
    return null;
  }
  if (payload.kind === "message" && typeof payload.threadId === "string") {
    const message = payload.message as Record<string, unknown> | undefined;
    if (message?.role === "bot" && (message.kind ?? "text") === "text") return payload.threadId;
  }
  return null;
}

/** Durable and live entries after `since`, in the order they were numbered. */
export function replayAfter(durable: ReplayEntry[], live: LiveDeltaReplay, since: number): ReplayEntry[] {
  return [...durable.filter(entry => entry.seq > since), ...live.after(since)].sort((a, b) => a.seq - b.seq);
}
