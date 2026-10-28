// What happens after a call, and whenever the app comes back: push the job
// journal, post the call-end report, retry until the server takes both.

import type { VoiceCallEndRequest } from "../../../shared/voice-call";
import {
  flushEnds,
  flushJournal,
  type FlushResult,
  type VoiceEndQueue,
  type VoiceJournal,
  type VoiceServer,
} from "./journal";

/** Wait this long for the call-end flush of the journal before reporting anyway. */
export const END_FLUSH_WAIT_MS = 4_000;
/** Retry delays for a call-end report that did not land. */
export const END_RETRY_MS = [5_000, 15_000, 45_000, 120_000, 300_000] as const;

export interface OutboxTimers {
  setTimeout(fn: () => void, ms: number): unknown;
}

export interface Outbox {
  journal: VoiceJournal;
  ends: VoiceEndQueue;
  server: VoiceServer;
  timers?: OutboxTimers;
}

const retrying = new WeakSet<VoiceEndQueue>();

/** Keep retrying the queue on a backoff until it is empty or the delays run out. */
export function retryEnds(outbox: Outbox, attempt = 0): void {
  if (attempt >= END_RETRY_MS.length || retrying.has(outbox.ends)) return;
  retrying.add(outbox.ends);
  const timers = outbox.timers ?? { setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms) };
  timers.setTimeout(() => {
    retrying.delete(outbox.ends);
    void flushEnds(outbox.ends, outbox.server).then((left) => {
      if (left > 0) retryEnds(outbox, attempt + 1);
    });
  }, END_RETRY_MS[attempt]);
}

/** A call is over: flush its jobs (briefly), then queue and post the end
 * report. Always posts, even for a call that never connected; whatever does
 * not land stays queued and retries. */
export async function settleCall(
  engine: { flushJobs(): Promise<void>; endReport(): VoiceCallEndRequest },
  outbox: Outbox,
): Promise<void> {
  const timers = outbox.timers ?? { setTimeout: (fn: () => void, ms: number) => globalThis.setTimeout(fn, ms) };
  await Promise.race([engine.flushJobs(), new Promise<void>((resolve) => timers.setTimeout(resolve, END_FLUSH_WAIT_MS))]);
  outbox.ends.add({ request: engine.endReport(), tries: 0 });
  const left = await flushEnds(outbox.ends, outbox.server);
  if (left > 0) retryEnds(outbox);
}

/** Focus, network back, app start: push the journal and any waiting end
 * reports. `onSent` hears how many jobs landed (for "sent N jobs from your call"). */
export async function flushOutbox(outbox: Outbox, onSent?: (count: number) => void): Promise<FlushResult | null> {
  if (outbox.journal.list().length === 0 && outbox.ends.list().length === 0) return null;
  const result = outbox.journal.list().length > 0 ? await flushJournal(outbox.journal, outbox.server) : null;
  const sent = result?.results.filter((r) => r.status === "sent").length ?? 0;
  if (sent > 0) onSent?.(sent);
  const left = await flushEnds(outbox.ends, outbox.server);
  if (left > 0) retryEnds(outbox);
  return result;
}
