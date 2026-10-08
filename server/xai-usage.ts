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
  | { at: string; kind: "end"; callId: string; seconds: number };

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
export function recordVoiceCallEnd(dataDir: string, callId: string, seconds: number, now = new Date()): Promise<void> {
  const clean = Number.isFinite(seconds) ? Math.min(MAX_CALL_SECONDS, Math.max(0, Math.round(seconds))) : 0;
  return append(dataDir, { at: now.toISOString(), kind: "end", callId, seconds: clean });
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
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let row: Partial<VoiceRow>;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isVoiceCallId(row.callId) || typeof row.at !== "string") continue;
    if (row.kind === "start" && !calls.has(row.callId)) calls.set(row.callId, { date: row.at.slice(0, 10), seconds: null });
    if (row.kind === "end" && typeof row.seconds === "number") ends.set(row.callId, row.seconds);
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
  return {
    period: monthKey(now),
    calls: calls.size,
    seconds,
    unmeasured,
    today: byDay.get(todayKey) ?? { calls: 0, seconds: 0 },
    days: [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, day]) => ({ date, ...day })),
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
