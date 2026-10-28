// The on-device journal for voice calls v3. A job the caller confirmed is
// written here before anything is sent, and stays until the server answers
// `sent` or `duplicate` for that jobId (the route is idempotent on it, so
// resending is always safe). The call-end report rides the same kind of
// queue: it is retried until the server takes it.
//
// Storage and the server are injected so the drop / no-network paths run
// under vitest with fakes.

import type {
  VoiceCallEndRequest,
  VoiceCallEndResponse,
  VoiceCallEventRequest,
  VoiceJob,
  VoiceJobResult,
  VoiceJobsRequest,
  VoiceJobsResponse,
  VoiceToolRequest,
  VoiceToolResponse,
} from "../../../shared/voice-call";

/** The subset of localStorage the journal uses. */
export interface KVStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The v3 server routes the call engine talks to. */
export interface VoiceServer {
  jobs(request: VoiceJobsRequest): Promise<VoiceJobsResponse>;
  event(request: VoiceCallEventRequest): Promise<unknown>;
  tool(request: VoiceToolRequest, signal?: AbortSignal): Promise<VoiceToolResponse>;
  end(request: VoiceCallEndRequest): Promise<VoiceCallEndResponse>;
}

/** A store that lives only in memory (tests, or a browser with storage off). */
export class MemoryStore implements KVStore {
  private readonly data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

/** localStorage when it works, memory otherwise. */
export function browserStore(): KVStore {
  try {
    const probe = "bos.voice.probe";
    globalThis.localStorage.setItem(probe, "1");
    globalThis.localStorage.removeItem(probe);
    return globalThis.localStorage;
  } catch {
    return new MemoryStore();
  }
}

/** A small list persisted as JSON, keyed by an id so adds are idempotent. */
export class PersistentList<T> {
  constructor(
    private readonly store: KVStore,
    private readonly key: string,
    private readonly idOf: (item: T) => string,
  ) {}

  list(): T[] {
    try {
      const parsed = JSON.parse(this.store.getItem(this.key) ?? "[]");
      return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch {
      return [];
    }
  }

  private write(items: T[]): void {
    this.store.setItem(this.key, JSON.stringify(items));
  }

  /** Persist before returning: callers rely on this being durable. */
  add(item: T): void {
    const id = this.idOf(item);
    const items = this.list().filter((existing) => this.idOf(existing) !== id);
    items.push(item);
    this.write(items);
  }

  remove(ids: readonly string[]): void {
    if (ids.length === 0) return;
    const gone = new Set(ids);
    const items = this.list();
    const kept = items.filter((item) => !gone.has(this.idOf(item)));
    if (kept.length !== items.length) this.write(kept);
  }
}

export interface JournalEntry {
  callId: string;
  botId: string;
  job: VoiceJob;
  at: number;
}

export class VoiceJournal extends PersistentList<JournalEntry> {
  constructor(store: KVStore = browserStore(), key = "bos.voice.journal.v1") {
    super(store, key, (entry) => entry.job.jobId);
  }
}

export interface EndEntry {
  request: VoiceCallEndRequest;
  tries: number;
}

export class VoiceEndQueue extends PersistentList<EndEntry> {
  constructor(store: KVStore = browserStore(), key = "bos.voice.ends.v1") {
    super(store, key, (entry) => entry.request.callId);
  }
}

export interface FlushResult {
  /** What the server answered for each job it took this pass. */
  results: VoiceJobResult[];
  /** Jobs still in the journal afterwards. */
  remaining: number;
}

const flights = new WeakMap<object, Promise<FlushResult>>();

/** Send every journaled job. Only `sent` / `duplicate` remove an entry; a
 * thrown request, a `failed` result or a missing result keeps it for the
 * next flush. One pass at a time: a call made mid-flight waits, then runs
 * again so a job added meanwhile is not left behind. */
export function flushJournal(journal: VoiceJournal, server: VoiceServer): Promise<FlushResult> {
  const running = flights.get(journal);
  if (running) return running.then(() => flushJournal(journal, server));
  const pass = (async (): Promise<FlushResult> => {
    {
      const results: VoiceJobResult[] = [];
      const groups = new Map<string, JournalEntry[]>();
      for (const entry of journal.list()) {
        const key = `${entry.callId}\u0000${entry.botId}`;
        groups.set(key, [...(groups.get(key) ?? []), entry]);
      }
      for (const entries of groups.values()) {
        const first = entries[0];
        try {
          const response = await server.jobs({ callId: first.callId, botId: first.botId, jobs: entries.map((entry) => entry.job) });
          const landed: string[] = [];
          for (const result of response?.results ?? []) {
            if (result.status === "sent" || result.status === "duplicate") landed.push(result.jobId);
            results.push(result);
          }
          journal.remove(landed);
        } catch {
          // Uncertain: keep every entry in this group.
        }
      }
      return { results, remaining: journal.list().length };
    }
  })();
  flights.set(journal, pass);
  // Cleared after the set: a pass with nothing to await finishes synchronously.
  const clear = () => void flights.delete(journal);
  pass.then(clear, clear);
  return pass;
}

const endFlights = new WeakMap<object, Promise<number>>();

/** An answer that retrying will never change (bad request, no such route,
 * an older server). Everything else, including no answer at all, is retried. */
export function isPermanentFailure(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" && [400, 404, 410, 413, 422].includes(status);
}

/** Post every queued call-end report; a 2xx removes it. Returns how many
 * are still queued. */
export function flushEnds(queue: VoiceEndQueue, server: VoiceServer): Promise<number> {
  const running = endFlights.get(queue);
  if (running) return running.then(() => flushEnds(queue, server));
  const pass = (async () => {
    {
      for (const entry of queue.list()) {
        try {
          await server.end(entry.request);
          queue.remove([entry.request.callId]);
        } catch (error) {
          if (isPermanentFailure(error)) queue.remove([entry.request.callId]);
          else queue.add({ ...entry, tries: entry.tries + 1 });
        }
      }
      return queue.list().length;
    }
  })();
  endFlights.set(queue, pass);
  const clear = () => void endFlights.delete(queue);
  pass.then(clear, clear);
  return pass;
}
