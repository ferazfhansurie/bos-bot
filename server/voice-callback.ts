// Voice call-backs. Work the owner gave out loud on a voice call rings them
// back when it settles, done or failed: a CallKit call, so a car's screen and
// steering-wheel button answer it, and the call opens with the result. The
// voice_work_done banner still goes too, so a missed ring leaves the result on
// the lock screen. Asked for from the car (2026-10-27): the banner alone went
// unseen, so finished work felt like silence.
//
// Only call-given work rings. Routines, drafts and everything else keep their
// banners. One ring per settled batch, never retried: a declined or missed
// ring is answered by the banner.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomic } from "./atomic.ts";
import { summarize } from "./notify.ts";

/** A batch rings once nothing new settled for this long… */
export const CALLBACK_QUIET_MS = 20_000;
/** …and never later than this after its first job settled. */
export const CALLBACK_BATCH_MAX_MS = 60_000;
/** Work that settles this long after it was asked for is old news: banner. */
export const CALLBACK_STALE_MS = 3 * 60 * 60_000;
/** 23:00–08:00 in the owner's time zone: banner only. */
export const QUIET_START_HOUR = 23;
export const QUIET_END_HOUR = 8;
/** A call with no end report is treated as over after this long. */
export const LIVE_CALL_MAX_MS = 2 * 60 * 60_000;

export type CallbackAction = "ring" | "banner" | "in_call";

export interface CallbackFacts {
  /** the owner's "call me back when voice jobs finish" switch */
  enabled: boolean;
  /** the bot's notifications switch is off (BotRecord.notifications false) */
  muted: boolean;
  /** the owner is on a voice call right now */
  onCall: boolean;
  /** when the work was asked for on the call (the user message's time) */
  askedAt: number;
  now: number;
  timeZone?: string;
}

/** Ring, banner only, or let the live call say it. The banner goes in every
 * case; this only decides whether a ring goes with it. A live call speaks
 * the result itself (the phone feeds voice_work_done frames into it). */
export function callbackDecision(facts: CallbackFacts): { action: CallbackAction; why: string } {
  if (!facts.enabled) return { action: "banner", why: "call-backs are off" };
  if (facts.muted) return { action: "banner", why: "bot is muted" };
  if (facts.onCall) return { action: "in_call", why: "already on a call" };
  if (facts.now - facts.askedAt > CALLBACK_STALE_MS) return { action: "banner", why: "asked more than 3 hours ago" };
  if (quietHours(facts.now, facts.timeZone)) return { action: "banner", why: "quiet hours" };
  return { action: "ring", why: "voice job settled" };
}

export function quietHours(at: number, timeZone?: string): boolean {
  const hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", ...(timeZone ? { timeZone } : {}) }).format(at));
  return hour >= QUIET_START_HOUR || hour < QUIET_END_HOUR;
}

export interface CallbackJob {
  botId: string;
  botName: string;
  threadId: string;
  /** the turn's last reply */
  reply: string;
  /** set when the work stopped before finishing: why, possibly empty */
  failure?: string;
}

/** One job's line: the reply's gist, or "it stopped: <why>". */
export function callbackLine(job: Pick<CallbackJob, "reply" | "failure">): string {
  if (job.failure !== undefined) {
    const why = summarize(job.failure);
    return `it stopped: ${why || "no reason given"}`;
  }
  return summarize(job.reply) || "it's done.";
}

/** The ring's reason: what CallKit's banner shows and the call opens with. */
export function callbackReason(jobs: readonly CallbackJob[]): string {
  if (jobs.length === 1) return callbackLine(jobs[0]!).slice(0, 500);
  const lines = jobs.map(job => `${job.botName}: ${callbackLine(job)}`);
  return `${jobs.length} jobs from your call are back. ${lines.join(" ")}`.slice(0, 500);
}

interface CallbackOptions {
  now?: () => number;
  /** Re-checked when the batch rings: a call may have started meanwhile. */
  stillRing(): boolean;
  ring(input: { botId: string; threadId: string; reason: string }, botName: string): void;
}

/** Collects settled voice jobs into one ring. */
export class VoiceCallbacks {
  private batch: { jobs: CallbackJob[]; firstAt: number; timer: ReturnType<typeof setTimeout> } | null = null;
  private readonly options: CallbackOptions;
  constructor(options: CallbackOptions) { this.options = options; }

  add(job: CallbackJob): void {
    const now = (this.options.now ?? Date.now)();
    if (this.batch) clearTimeout(this.batch.timer);
    const batch = this.batch ?? { jobs: [], firstAt: now, timer: undefined as unknown as ReturnType<typeof setTimeout> };
    batch.jobs.push(job);
    const wait = Math.max(0, Math.min(CALLBACK_QUIET_MS, batch.firstAt + CALLBACK_BATCH_MAX_MS - now));
    batch.timer = setTimeout(() => this.flush(), wait);
    batch.timer.unref?.();
    this.batch = batch;
  }

  /** Ring for everything collected so far. */
  flush(): void {
    const batch = this.batch;
    if (!batch) return;
    clearTimeout(batch.timer);
    this.batch = null;
    if (!this.options.stillRing()) return;
    // the newest job's bot rings, in that job's thread; the reason carries
    // every job, so one answer hears them all
    const last = batch.jobs.at(-1)!;
    try {
      this.options.ring({ botId: last.botId, threadId: last.threadId, reason: callbackReason(batch.jobs) }, last.botName);
    } catch (error) {
      console.warn(`voice call-back ring failed: ${error instanceof Error ? error.message : "unknown failure"}`);
    }
  }

  get pending(): number { return this.batch?.jobs.length ?? 0; }
}

/** Calls the owner is on: booked when a call starts, dropped at its end
 * report. A call whose end never arrived stops counting after two hours. */
export class LiveVoiceCalls {
  private readonly calls = new Map<string, number>();
  private readonly now: () => number;
  constructor(now: () => number = Date.now) { this.now = now; }
  start(callId: string): void { this.calls.set(callId, this.now()); }
  end(callId: string): void { this.calls.delete(callId); }
  onCall(): boolean {
    const now = this.now();
    for (const [callId, at] of this.calls) if (now - at > LIVE_CALL_MAX_MS) this.calls.delete(callId);
    return this.calls.size > 0;
  }
}

/** The owner's switch, default on. */
export class CallbackPreference {
  private readonly file: string;
  private value: boolean;
  constructor(file: string) {
    this.file = file;
    this.value = true;
    if (!existsSync(file)) return;
    try {
      const data = JSON.parse(readFileSync(file, "utf8")) as { enabled?: unknown };
      if (typeof data.enabled === "boolean") this.value = data.enabled;
    } catch { /* unreadable: default on */ }
  }
  get enabled(): boolean { return this.value; }
  set(enabled: boolean): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.file, JSON.stringify({ enabled }), { mode: 0o600 });
    this.value = enabled;
  }
}
