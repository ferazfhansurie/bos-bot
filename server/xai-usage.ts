// xAI voice usage and prepaid credits for Settings → Usage and the sidebar.
//
// Two sources, kept apart on purpose:
//   - our own tally: every realtime voice call the server mints a secret for
//     is booked here (start at mint, length when the client hangs up), month
//     by month under <data>/voice-usage/. Rows carry ids and seconds, never
//     transcript or audio.
//   - xAI's own books: the normal API key cannot read billing, so credits
//     left come from the management API (management-api.x.ai) and only when
//     the user saved a management key. Without one the card shows the tally
//     alone, never an error.
import { readFileSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const DIR = "voice-usage";
const MANAGEMENT_API = "https://management-api.x.ai";
/** xAI's billing pages are not live to the second; 5 min keeps us polite. */
export const XAI_BILLING_TTL_MS = 5 * 60_000;
/** a call longer than this is a client clock bug, not a call */
const MAX_CALL_SECONDS = 4 * 60 * 60;
const writeQueues = new Map<string, Promise<void>>();

type VoiceRow =
  | { at: string; kind: "start"; callId: string; botId: string | null }
  | { at: string; kind: "end"; callId: string; seconds: number; jobsSaid?: number; jobsSent?: number }
  | { at: string; kind: "event"; callId: string; event: VoiceEventKind; ms?: number; good?: boolean };

/** v3 call quality counters (plans/voice-v3/contract.md). */
export type VoiceEventKind = "first_audio" | "drop" | "resume" | "unclear" | "memo" | "rating";
const EVENT_KINDS = new Set<VoiceEventKind>(["first_audio", "drop", "resume", "unclear", "memo", "rating"]);
export const isVoiceEventKind = (value: unknown): value is VoiceEventKind => typeof value === "string" && EVENT_KINDS.has(value as VoiceEventKind);
/** grok voice ≈ $0.08 a minute (third-party figure, not xAI's page); rm at 4.2. */
export const RM_PER_MINUTE = 0.08 * 4.2;
/** A call's rough cost in rm, to the sen. */
export const voiceRm = (seconds: number) => Math.round((seconds / 60) * RM_PER_MINUTE * 100) / 100;

function monthKey(at: Date): string {
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function voiceUsageFileFor(dataDir: string, at: Date): string {
  return join(dataDir, DIR, `${monthKey(at)}.jsonl`);
}

function append(dataDir: string, row: VoiceRow): Promise<void> {
  const dir = join(dataDir, DIR);
  const file = voiceUsageFileFor(dataDir, new Date(row.at));
  const previous = writeQueues.get(dir) ?? Promise.resolve();
  const next = previous
    .then(async () => {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await appendFile(file, `${JSON.stringify(row)}\n`, { mode: 0o600 });
    })
    // bookkeeping never fails the call it is booking
    .catch(() => {});
  writeQueues.set(dir, next);
  return next;
}

export function flushVoiceUsage(dataDir: string): Promise<void> {
  return writeQueues.get(join(dataDir, DIR)) ?? Promise.resolve();
}

const CALL_ID = /^[A-Za-z0-9_-]{8,64}$/;
export const isVoiceCallId = (value: unknown): value is string => typeof value === "string" && CALL_ID.test(value);

/** A mint opened (or re-opened) a call. Reconnects reuse the callId and
 * count once when summed. */
export function recordVoiceCallStart(dataDir: string, callId: string, botId: string | null, now = new Date()): Promise<void> {
  return append(dataDir, { at: now.toISOString(), kind: "start", callId, botId });
}

/** The client hung up after `seconds` connected. The last report wins. */
export function recordVoiceCallEnd(dataDir: string, callId: string, seconds: number, now = new Date(), jobs?: { said: number; sent: number }): Promise<void> {
  const clean = Number.isFinite(seconds) ? Math.min(MAX_CALL_SECONDS, Math.max(0, Math.round(seconds))) : 0;
  const count = (n: number) => (Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : 0);
  return append(dataDir, { at: now.toISOString(), kind: "end", callId, seconds: clean, ...(jobs ? { jobsSaid: count(jobs.said), jobsSent: count(jobs.sent) } : {}) });
}

/** One quality event from a v3 client (drop, resume, first audio, …). */
export function recordVoiceEvent(dataDir: string, callId: string, event: { kind: VoiceEventKind; ms?: number; good?: boolean }, now = new Date()): Promise<void> {
  const ms = typeof event.ms === "number" && Number.isFinite(event.ms) ? Math.min(600_000, Math.max(0, Math.round(event.ms))) : undefined;
  return append(dataDir, {
    at: now.toISOString(), kind: "event", callId, event: event.kind,
    ...(ms !== undefined ? { ms } : {}),
    ...(event.kind === "rating" ? { good: event.good === true } : {}),
  });
}

export interface VoiceQuality {
  drops: number;
  resumes: number;
  firstAudioP50: number | null;
  firstAudioP90: number | null;
  unclear: number;
  memos: number;
  good: number;
  bad: number;
  jobsSaid: number;
  jobsSent: number;
  /** grok voice minutes at ~$0.08/min, in rm */
  rmEstimate: number;
}

function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

export interface VoiceTally {
  /** "YYYY-MM", UTC, the same cycle xAI bills on */
  period: string;
  calls: number;
  seconds: number;
  /** calls that never reported a length (a phone that dropped, an older client) */
  unmeasured: number;
  today: { calls: number; seconds: number };
  days: Array<{ date: string; calls: number; seconds: number }>;
  quality: VoiceQuality;
}

/** Sum this month's calls, one per callId, by the day they started. */
export function summarizeVoiceUsage(dataDir: string, now = new Date()): VoiceTally {
  let text = "";
  try {
    text = readFileSync(voiceUsageFileFor(dataDir, now), "utf8");
  } catch {
    /* no calls this month */
  }
  const calls = new Map<string, { date: string; seconds: number | null }>();
  const ends = new Map<string, number>();
  const jobs = new Map<string, { said: number; sent: number }>();
  const ratings = new Map<string, boolean>();
  const firstAudio = new Map<string, number>();
  const q = { drops: 0, resumes: 0, unclear: 0, memos: 0 };
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let row: { at?: unknown; kind?: unknown; callId?: unknown; seconds?: unknown; jobsSaid?: unknown; jobsSent?: unknown; event?: unknown; ms?: unknown; good?: unknown };
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isVoiceCallId(row.callId) || typeof row.at !== "string") continue;
    if (row.kind === "start" && !calls.has(row.callId)) calls.set(row.callId, { date: row.at.slice(0, 10), seconds: null });
    if (row.kind === "end" && typeof row.seconds === "number") {
      ends.set(row.callId, row.seconds);
      if (typeof row.jobsSaid === "number") jobs.set(row.callId, { said: row.jobsSaid, sent: typeof row.jobsSent === "number" ? row.jobsSent : 0 });
    }
    if (row.kind === "event") {
      if (row.event === "drop") q.drops += 1;
      else if (row.event === "resume") q.resumes += 1;
      else if (row.event === "unclear") q.unclear += 1;
      else if (row.event === "memo") q.memos += 1;
      else if (row.event === "rating") ratings.set(row.callId, row.good === true);
      else if (row.event === "first_audio" && typeof row.ms === "number" && !firstAudio.has(row.callId)) firstAudio.set(row.callId, row.ms);
    }
  }
  for (const [callId, seconds] of ends) {
    const call = calls.get(callId);
    if (call) call.seconds = seconds;
  }
  const byDay = new Map<string, { calls: number; seconds: number }>();
  let seconds = 0;
  let unmeasured = 0;
  for (const call of calls.values()) {
    const day = byDay.get(call.date) ?? { calls: 0, seconds: 0 };
    day.calls += 1;
    day.seconds += call.seconds ?? 0;
    byDay.set(call.date, day);
    seconds += call.seconds ?? 0;
    if (call.seconds === null) unmeasured += 1;
  }
  const todayKey = now.toISOString().slice(0, 10);
  const audio = [...firstAudio.values()].sort((a, b) => a - b);
  const quality: VoiceQuality = {
    ...q,
    firstAudioP50: percentile(audio, 50),
    firstAudioP90: percentile(audio, 90),
    good: [...ratings.values()].filter(Boolean).length,
    bad: [...ratings.values()].filter((good) => !good).length,
    jobsSaid: [...jobs.values()].reduce((n, row) => n + row.said, 0),
    jobsSent: [...jobs.values()].reduce((n, row) => n + row.sent, 0),
    rmEstimate: voiceRm(seconds),
  };
  return {
    period: monthKey(now),
    calls: calls.size,
    seconds,
    unmeasured,
    today: byDay.get(todayKey) ?? { calls: 0, seconds: 0 },
    days: [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, day]) => ({ date, ...day })),
    quality,
  };
}

// ── xAI management API ────────────────────────────────────────────────────

export interface XaiCredits {
  /** prepaid credits bought, US cents */
  purchasedCents: number;
  /** prepaid credits spent this billing cycle, US cents */
  usedCents: number;
  remainingCents: number;
  /** xAI's own count of grok-voice seconds and their cost this cycle */
  voiceSeconds: number;
  voiceCents: number;
  cycle: string | null;
}

export type XaiCreditsView =
  | { configured: false }
  | { configured: true; credits: XaiCredits | null; fetchedAt: number | null; error: string | null };

/** xAI sends money as {val:"-500"} in cents, negative for credit. */
function cents(value: unknown): number {
  const raw = value && typeof value === "object" && "val" in value ? (value as { val: unknown }).val : value;
  const parsed = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(parsed) ? Math.abs(parsed) : 0;
}

async function getJson(fetchImpl: typeof fetch, key: string, path: string): Promise<any> {
  const res = await fetchImpl(`${MANAGEMENT_API}${path}`, {
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    // the status is enough; xAI's body can echo request details we don't want in a log
    throw new Error(res.status === 401 || res.status === 403 ? "xAI rejected the management key" : `xAI billing is unavailable (${res.status})`);
  }
  return res.json();
}

export async function fetchXaiCredits(key: string, fetchImpl: typeof fetch = fetch): Promise<XaiCredits> {
  const who = await getJson(fetchImpl, key, "/auth/management-keys/validation");
  const team = typeof who?.teamId === "string" ? who.teamId : typeof who?.scopeId === "string" ? who.scopeId : "";
  if (!/^[A-Za-z0-9-]{8,64}$/.test(team)) throw new Error("xAI did not say which team this management key belongs to");
  const base = `/v1/billing/teams/${encodeURIComponent(team)}`;
  const [balance, preview] = await Promise.all([
    getJson(fetchImpl, key, `${base}/prepaid/balance`),
    getJson(fetchImpl, key, `${base}/postpaid/invoice/preview`),
  ]);
  const invoice = preview?.coreInvoice ?? {};
  const purchasedCents = cents(invoice.prepaidCredits) || cents(balance?.total);
  const usedCents = cents(invoice.prepaidCreditsUsed);
  let voiceSeconds = 0;
  let voiceCents = 0;
  for (const line of Array.isArray(invoice.lines) ? invoice.lines : []) {
    if (!/grok-voice|realtime/i.test(String(line?.description ?? ""))) continue;
    if (/second/i.test(String(line?.unitType ?? ""))) voiceSeconds += cents(line?.numUnits);
    voiceCents += cents(line?.amount);
  }
  const cycle = preview?.billingCycle?.year && preview?.billingCycle?.month
    ? `${preview.billingCycle.year}-${String(preview.billingCycle.month).padStart(2, "0")}`
    : null;
  return { purchasedCents, usedCents, remainingCents: Math.max(0, purchasedCents - usedCents), voiceSeconds, voiceCents, cycle };
}

/** One cached reader per server. A failed refresh keeps the last good value
 * and says when it was read, so offline still shows a number. */
export function createXaiCreditsReader(fetchImpl: typeof fetch = fetch, now: () => number = Date.now, ttlMs = XAI_BILLING_TTL_MS) {
  let last: { key: string; credits: XaiCredits; fetchedAt: number } | null = null;
  let tried: { key: string; at: number; error: string | null } | null = null;
  let inFlight: { key: string; promise: Promise<void> } | null = null;

  const refresh = (key: string) => {
    if (inFlight?.key === key) return inFlight.promise;
    const promise = fetchXaiCredits(key, fetchImpl)
      .then((credits) => {
        last = { key, credits, fetchedAt: now() };
        tried = { key, at: now(), error: null };
      })
      .catch((error: unknown) => {
        tried = { key, at: now(), error: error instanceof Error ? error.message : "xAI billing is unavailable" };
      })
      .finally(() => {
        if (inFlight?.promise === promise) inFlight = null;
      });
    inFlight = { key, promise };
    return promise;
  };

  return async function read(managementKey: string | undefined): Promise<XaiCreditsView> {
    const key = managementKey?.trim();
    if (!key) return { configured: false };
    if (!tried || tried.key !== key || now() - tried.at >= ttlMs) await refresh(key);
    const good = last?.key === key ? last : null;
    return {
      configured: true,
      credits: good?.credits ?? null,
      fetchedAt: good?.fetchedAt ?? null,
      error: tried?.key === key ? tried.error : null,
    };
  };
}
