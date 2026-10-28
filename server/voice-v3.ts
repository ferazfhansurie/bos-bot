// Voice calls v3, server side. Spec: plans/voice-v3/contract.md.
//
// Everything a call needs from the rest of the server comes in through
// VoiceWorld, so this file holds the rules (brief, job routing, the fast read
// tools, the card after hang-up, the memory note) and index.ts only wires the
// store in. State that has to outlive a restart (which jobId became which
// thread, which call left which card, the last call summaries) lives in
// <data>/voice-calls/state.json; vocabulary hints in <data>/voice-calls/keyterms.txt.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type {
  VoiceBrief, VoiceCallCard, VoiceCallEndRequest, VoiceCallEndResponse, VoiceCallSummaryJob, VoiceJobResult,
  VoiceJobsRequest, VoiceJobStatus, VoiceToolRequest, VoiceTranscriptLine,
} from "../shared/voice-call.ts";

const DIR = "voice-calls";
const MAX_KEYTERMS = 100;
const MAX_KEYTERM_CHARS = 50;
const MAX_JOBS_KEPT = 500;
const JOB_TTL_MS = 30 * 24 * 60 * 60_000;
const MAX_CALLS_KEPT = 300;
const SUMMARIES_PER_BOT = 10;
const BRIEF_TTL_MS = 60_000;
const MAX_JOB_CHARS = 2000;
const MAX_TRANSCRIPT_LINES = 400;
const MAX_LINE_CHARS = 2000;
/** memory/voice.md keeps this much; older call notes fall off the top. */
const VOICE_NOTES_MAX_CHARS = 12_000;
export const VOICE_NOTES_PATH = "memory/voice.md";
/** A bot's own extra brief (e.g. /data health, new leads), refreshed by its routines. */
export const VOICE_BRIEF_PATH = "memory/voice-brief.md";
export const SCREEN_ONLY = "that one needs a tap on screen.";

export interface VoiceNeedsMeItem {
  id: string;
  botId: string;
  botName: string;
  threadId: string;
  title: string;
  preview: string;
  messageId?: string;
  requestId?: string;
  approval?: boolean;
  options?: string[];
  freeText?: boolean;
}

export interface VoiceThreadView {
  botId: string;
  botName: string;
  threadId: string;
  title: string;
  /** running | waiting-on-you | queued | idle | closed */
  state: string;
  /** the newest bot line, plain text */
  last?: string;
  at: number;
}

export interface VoiceWorld {
  now(): number;
  timeZone?: string;
  userName?: string;
  /** Bots a job can go to (visible ones). */
  roster(): Array<{ id: string; name: string }>;
  memory(botId: string, path: string): string;
  memoryTopics(botId: string): string[];
  /** Replace a memory doc; `update` gets the current text. */
  writeMemory(botId: string, path: string, update: (before: string) => string): void;
  /** Threads that are running, queued or waiting on the person, newest first. */
  openWork(limit: number): VoiceThreadView[];
  /** Threads whose title or newest bot line match (status, follow_up by topic). */
  findThreads(words: string[], limit: number): VoiceThreadView[];
  thread(botId: string, threadId: string): VoiceThreadView | null;
  needsMe(): VoiceNeedsMeItem[];
  routineRuns(from: number, to: number): Array<{ name: string; botName: string; status: string; at: number; output?: string }>;
  upcoming(from: number, to: number): Array<{ name: string; at: number; kind: "routine" | "call" }>;
  /** Open a new thread on botId and start the job there. `opened` hears the
   * thread before the send, so a retry can find it; with `threadId` it reuses
   * that thread and sends nothing if `sendId` was already accepted there. A
   * failed first send deletes the empty thread it opened. */
  startJob(input: { botId: string; title: string; text: string; callId: string; sendId: string; threadId?: string; opened?: (threadId: string) => void }): Promise<{ threadId: string }>;
  /** Add a message to an existing thread as the person, from the call. Once
   * per sendId. */
  sendToThread(input: { botId: string; threadId: string; text: string; callId: string; sendId: string }): Promise<void>;
  /** Answer a live question card (requestId) with words. */
  answerQuestion(item: VoiceNeedsMeItem, answer: string): Promise<boolean>;
  /** Write the voice chat card into a new thread on botId. */
  postCard(botId: string, card: VoiceCallCard, text: string): { threadId: string; messageId: string };
  patchCard(botId: string, threadId: string, messageId: string, card: VoiceCallCard, text: string): void;
  /** The card as stored, for a rating or late job after a restart. */
  readCard(threadId: string, messageId: string): VoiceCallCard | null;
  summarize?(transcript: VoiceTranscriptLine[], jobs: string[]): Promise<{ summary: string; facts: string[] } | null>;
}

/** starting: the thread exists, the send may not have landed yet. No status
 * is an older sent row. */
interface JobRow { botId: string; threadId: string; callId: string; text: string; at: number; status?: "starting" | "sent" }
interface CallRow { botId: string; threadId: string; messageId: string; at: number }
interface SummaryRow { at: number; callId: string; summary: string }
interface State {
  jobs: Record<string, JobRow>;
  calls: Record<string, CallRow>;
  summaries: Record<string, SummaryRow[]>;
}

/** Marks a follow-up that became its own thread; topic matching ignores
 * the other thread's title after it. */
const ABOUT_THREAD = "\n\n(said on a voice call about the thread ";
const spoken = (text: string) => text.split(ABOUT_THREAD)[0] ?? text;
const JOB_ID = /^[A-Za-z0-9_-]{6,80}$/;
export const isVoiceJobId = (value: unknown): value is string => typeof value === "string" && JOB_ID.test(value);

const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
};

/** Markdown and ids read badly out loud; the model gets plain lines. */
function plain(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "(link)")
    .replace(/[*_#>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STOP = new Set(["the", "a", "an", "and", "or", "of", "to", "on", "in", "is", "it", "my", "me", "for", "how", "what", "whats", "what's", "with", "about", "any", "did", "do", "does", "going", "doing", "status", "update", "latest", "uh", "um", "erm", "hmm", "ah", "eh", "like", "you", "know", "so", "yeah", "okay", "ok", "lah"]);
export function topicWords(topic: string): string[] {
  return [...new Set(topic.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1 && !STOP.has(w)))].slice(0, 6);
}

function score(text: string, words: string[]): number {
  const lower = text.toLowerCase();
  return words.reduce((n, word) => n + (lower.includes(word) ? 1 : 0), 0);
}

export function cleanKeyterms(terms: Iterable<unknown>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const term of terms) {
    if (typeof term !== "string") continue;
    const clean = term.replace(/\s*\([^)]*\)\s*/g, " ").trim().slice(0, MAX_KEYTERM_CHARS).trim();
    if (!clean || clean.startsWith("#") || seen.has(clean.toLowerCase())) continue;
    seen.add(clean.toLowerCase());
    out.push(clean);
    if (out.length >= MAX_KEYTERMS) break;
  }
  return out;
}

export function formatSeconds(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The text an older client shows for the card message. */
export function voiceCardText(card: VoiceCallCard): string {
  const head = `voice chat · ${formatSeconds(card.seconds)}`;
  const jobs = card.jobs.filter((job) => job.status !== "cancelled");
  return [head, card.summary, jobs.length ? `jobs: ${jobs.map((job) => clip(job.text, 80)).join("; ")}` : ""]
    .filter(Boolean).join("\n");
}

function fallbackSummary(transcript: VoiceTranscriptLine[], jobs: string[]): string {
  if (jobs.length) return clip(`asked for ${jobs.length === 1 ? "one job" : `${jobs.length} jobs`}: ${jobs.map((job) => clip(job, 60)).join("; ")}`, 240);
  const said = transcript.filter((line) => line.role === "user" && line.text.trim()).map((line) => line.text.trim());
  if (!said.length) return "a short call, nothing said.";
  return clip(`talked about: ${said.slice(0, 3).join(" / ")}`, 240);
}

export class VoiceCalls {
  private state: State;
  private readonly file: string;
  private readonly keytermsFile: string;
  private readonly briefs = new Map<string, VoiceBrief>();
  private readonly inflightJobs = new Map<string, Promise<VoiceJobResult>>();
  private readonly inflightEnds = new Map<string, Promise<VoiceCallEndResponse>>();
  /** per call: the needs_me list as last read out, so "the first one" resolves */
  private readonly needsMeOrder = new Map<string, { at: number; items: VoiceNeedsMeItem[] }>();

  private readonly dataDir: string;
  private readonly world: VoiceWorld;

  constructor(dataDir: string, world: VoiceWorld) {
    this.dataDir = dataDir;
    this.world = world;
    this.file = join(dataDir, DIR, "state.json");
    this.keytermsFile = join(dataDir, DIR, "keyterms.txt");
    this.state = this.load();
  }

  private load(): State {
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<State>;
      return { jobs: raw.jobs ?? {}, calls: raw.calls ?? {}, summaries: raw.summaries ?? {} };
    } catch {
      return { jobs: {}, calls: {}, summaries: {} };
    }
  }

  private save(): void {
    const now = this.world.now();
    const jobs = Object.entries(this.state.jobs).filter(([, job]) => now - job.at < JOB_TTL_MS).sort(([, a], [, b]) => b.at - a.at).slice(0, MAX_JOBS_KEPT);
    const calls = Object.entries(this.state.calls).sort(([, a], [, b]) => b.at - a.at).slice(0, MAX_CALLS_KEPT);
    this.state = { jobs: Object.fromEntries(jobs), calls: Object.fromEntries(calls), summaries: this.state.summaries };
    mkdirSync(join(this.dataDir, DIR), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  // ── plan inputs ─────────────────────────────────────────────────────────

  /** The person's own terms (keyterms.txt, one per line) plus every bot's
   * name and their own first name. */
  keyterms(): string[] {
    let saved: string[] = [];
    try {
      saved = readFileSync(this.keytermsFile, "utf8").split("\n");
    } catch {
      /* none saved */
    }
    const first = this.world.userName?.trim().split(/\s+/)[0];
    return cleanKeyterms([...saved, ...this.world.roster().map((bot) => bot.name), ...(first ? [first] : [])]);
  }

  roster(): Array<{ id: string; name: string }> {
    return this.world.roster();
  }

  /** What the call starts knowing. Cached for a minute so a prewarm and the
   * tap right after it don't build it twice. */
  brief(botId: string): VoiceBrief {
    const now = this.world.now();
    const cached = this.briefs.get(botId);
    if (cached && now - cached.builtAt < BRIEF_TTL_MS) return cached;
    const brief = { text: this.buildBrief(botId, now), builtAt: now };
    this.briefs.set(botId, brief);
    return brief;
  }

  private buildBrief(botId: string, now: number): string {
    const w = this.world;
    const tz = w.timeZone;
    const date = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, ...(tz ? { timeZone: tz } : {}) }).format(now);
    const time = (at: number) => new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, ...(tz ? { timeZone: tz } : {}) }).format(at);
    const sections: string[] = [`now: ${date}${tz ? ` (${tz})` : ""}`];

    const memory = w.memory(botId, "MEMORY.md").trim();
    if (memory) sections.push(`what you remember:\n${clip(memory, 2500)}`);

    const past = (this.state.summaries[botId] ?? []).slice(-3);
    if (past.length) sections.push(`last calls:\n${past.map((row) => `- ${new Date(row.at).toISOString().slice(0, 10)} ${time(row.at)}: ${row.summary}`).join("\n")}`);

    const work = w.openWork(8);
    // other bots' threads give title and state only; their words come out
    // when asked for (status, check_jobs), not in every call's brief
    if (work.length) sections.push(`open work:\n${work.map((t) => `- ${t.botName} · ${clip(t.title, 60)}: ${t.state}${t.last && t.botId === botId ? `. last: ${clip(plain(t.last), 120)}` : ""}`).join("\n")}`);

    const waiting = w.needsMe().slice(0, 5);
    if (waiting.length) sections.push(`waiting on them (${waiting.length}${waiting.length === 5 ? "+" : ""}):\n${waiting.map((item) => `- ${item.botName}: ${clip(plain(item.title), 60)}. ${clip(plain(item.preview), 100)}`).join("\n")}`);

    const dayStart = startOfDay(now, tz);
    const runs = w.routineRuns(dayStart, now).slice(0, 6);
    if (runs.length) sections.push(`routines today:\n${runs.map((run) => `- ${run.name} (${run.botName}) ${run.status} ${time(run.at)}${run.output ? `: ${clip(plain(run.output), 140)}` : ""}`).join("\n")}`);

    const later = w.upcoming(now, dayStart + 24 * 60 * 60_000).slice(0, 5);
    if (later.length) sections.push(`later today:\n${later.map((item) => `- ${time(item.at)} ${item.name}`).join("\n")}`);

    const extra = w.memory(botId, VOICE_BRIEF_PATH).trim();
    if (extra) sections.push(`more:\n${clip(extra, 1500)}`);
    return sections.join("\n\n");
  }

  // ── jobs ────────────────────────────────────────────────────────────────

  /** Route a spoken bot name (or id) to a roster bot; default the called bot. */
  route(called: string, said?: string): { id: string; name: string } {
    const roster = this.world.roster();
    const fallback = roster.find((bot) => bot.id === called) ?? { id: called, name: called };
    const want = said?.trim().toLowerCase();
    if (!want) return fallback;
    return roster.find((bot) => bot.id === said)
      ?? roster.find((bot) => bot.name.toLowerCase() === want)
      ?? roster.find((bot) => bot.name.toLowerCase().replace(/\s*\([^)]*\)/g, "").trim() === want)
      ?? roster.find((bot) => want.split(/\s+/).includes(bot.name.toLowerCase()))
      ?? fallback;
  }

  async jobs(request: VoiceJobsRequest): Promise<VoiceJobResult[]> {
    const results: VoiceJobResult[] = [];
    for (const job of request.jobs) {
      // one at a time per jobId: a retry racing the first send waits for it
      // and gets the same thread, never a second one
      let pending = this.inflightJobs.get(job.jobId);
      if (!pending) {
        pending = this.oneJob(request.callId, request.botId, job).finally(() => this.inflightJobs.delete(job.jobId));
        this.inflightJobs.set(job.jobId, pending);
      }
      results.push(await pending);
    }
    return results;
  }

  /** The jobs a call gave out, as they stand now (the end-of-call screen). */
  callJobs(callId: string): VoiceCallSummaryJob[] {
    return Object.entries(this.state.jobs)
      .filter(([, row]) => row.callId === callId && row.status === "sent")
      .sort(([, a], [, b]) => a.at - b.at)
      .slice(0, 20)
      .map(([jobId, row]) => {
        const view = this.world.thread(row.botId, row.threadId);
        const state = !view ? "done" : view.state === "running" || view.state === "queued" ? "working" : view.state === "waiting-on-you" ? "needs_you" : "done";
        return {
          jobId, text: clip(plain(spoken(row.text)), 140), botId: row.botId, botName: view?.botName ?? this.botName(row.botId), threadId: row.threadId, state,
          ...(view?.last ? { last: clip(plain(view.last), 200) } : {}),
        };
      });
  }

  private async oneJob(callId: string, calledBotId: string, job: { jobId: string; text: string; bot?: string }): Promise<VoiceJobResult> {
    const known = this.state.jobs[job.jobId];
    if (known && known.status !== "starting") {
      return { jobId: job.jobId, status: "duplicate", botId: known.botId, botName: this.botName(known.botId), threadId: known.threadId };
    }
    // a retry after a send that may or may not have landed: same bot, same
    // thread, and the world sends nothing if the first one was accepted
    const text = known?.text ?? job.text.trim();
    if (!text || text.length > MAX_JOB_CHARS) return { jobId: job.jobId, status: "failed", error: `job text must be 1 to ${MAX_JOB_CHARS} characters` };
    const bot = known ? { id: known.botId, name: this.botName(known.botId) } : this.route(calledBotId, job.bot);
    try {
      const { threadId } = await this.world.startJob({
        botId: bot.id, title: jobTitle(spoken(text)), text, callId, sendId: `voicejob-${job.jobId}`.slice(0, 80),
        ...(known ? { threadId: known.threadId } : {}),
        opened: (threadId) => {
          this.state.jobs[job.jobId] = { botId: bot.id, threadId, callId, text, at: this.world.now(), status: "starting" };
          this.save();
        },
      });
      this.state.jobs[job.jobId] = { botId: bot.id, threadId, callId, text, at: known?.at ?? this.world.now(), status: "sent" };
      this.save();
      this.patchCardJob(callId, job.jobId, { botId: bot.id, botName: bot.name, threadId, status: "sent" });
      return { jobId: job.jobId, status: "sent", botId: bot.id, botName: bot.name, threadId };
    } catch (error) {
      // the world deleted the thread when nothing landed: forget it so a
      // retry starts clean
      const row = this.state.jobs[job.jobId];
      if (row?.status === "starting" && !this.world.thread(row.botId, row.threadId)) {
        delete this.state.jobs[job.jobId];
        this.save();
      }
      return { jobId: job.jobId, status: "failed", botId: bot.id, botName: bot.name, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private botName(botId: string): string {
    return this.world.roster().find((bot) => bot.id === botId)?.name ?? botId;
  }

  /** A job that lands after the card was written updates its row. */
  private patchCardJob(callId: string, jobId: string, patch: { botId: string; botName: string; threadId: string; status: VoiceJobStatus }) {
    const call = this.state.calls[callId];
    if (!call) return;
    const card = this.card(callId);
    if (!card) return;
    const row = card.jobs.find((job) => job.jobId === jobId);
    if (row) Object.assign(row, patch);
    else card.jobs.push({ jobId, text: spoken(this.state.jobs[jobId]?.text ?? ""), ...patch });
    try {
      this.world.patchCard(call.botId, call.threadId, call.messageId, card, voiceCardText(card));
    } catch {
      /* the card is a view; the job itself landed */
    }
  }

  // ── fast read tools ─────────────────────────────────────────────────────

  async tool(request: VoiceToolRequest): Promise<string> {
    const args = request.args ?? {};
    const str = (key: string) => (typeof args[key] === "string" ? (args[key] as string).trim() : "");
    switch (request.name) {
      case "check_jobs": return this.checkJobs(request.callId, request.jobIds ?? []);
      case "recall_memory": return this.recallMemory(request.botId, str("query"));
      case "calendar": return this.calendar(str("day"));
      case "status": return this.status(request.botId, str("topic"));
      case "needs_me": return this.needsMe(request.callId);
      case "answer_item": return this.answerItem(request.callId, str("item"), str("answer"));
      case "follow_up": return this.followUp(request.callId, str("job_id"), str("topic"), str("text"));
      default: return `there is no tool named ${String(request.name)}.`;
    }
  }

  private checkJobs(callId: string, jobIds: string[]): string {
    const now = this.world.now();
    const dayStart = startOfDay(now, this.world.timeZone);
    const ids = new Set(jobIds);
    const mine = Object.entries(this.state.jobs).filter(([id, job]) => ids.has(id) || job.callId === callId);
    const rows = mine.length ? mine : Object.entries(this.state.jobs).filter(([, job]) => job.at >= dayStart);
    if (!rows.length) return "no jobs from calls today.";
    const lines = rows.sort(([, a], [, b]) => a.at - b.at).slice(-5).map(([, job]) => {
      const thread = this.world.thread(job.botId, job.threadId);
      const who = this.botName(job.botId);
      if (!thread) return `${who}: ${clip(spoken(job.text), 60)}: thread is gone.`;
      const state = thread.state === "running" ? "still running"
        : thread.state === "queued" ? "queued"
        : thread.state === "waiting-on-you" ? "waiting on you"
        : "done";
      return `${who}: ${clip(spoken(job.text), 60)}: ${state}${state !== "still running" && state !== "queued" && thread.last ? `. ${clip(plain(thread.last), 200)}` : ""}`;
    });
    return `${mine.length ? "this call" : "earlier calls today"}:\n${lines.join("\n")}`;
  }

  private recallMemory(botId: string, query: string): string {
    const words = topicWords(query);
    if (!words.length) return "say what to look for.";
    const docs = ["MEMORY.md", ...this.world.memoryTopics(botId).filter((path) => !path.startsWith("memory/log/")).slice(0, 40)];
    const hits: Array<{ s: number; line: string }> = [];
    for (const path of docs) {
      for (const line of this.world.memory(botId, path).split("\n")) {
        const s = score(line, words);
        if (s > 0 && line.trim().length > 3) hits.push({ s, line: clip(plain(line), 300) });
      }
    }
    if (!hits.length) return `nothing in memory about ${query}.`;
    return hits.sort((a, b) => b.s - a.s).slice(0, 5).map((hit) => `- ${hit.line}`).join("\n");
  }

  private calendar(day: string): string {
    const tz = this.world.timeZone;
    const now = this.world.now();
    const today = startOfDay(now, tz);
    let start = today;
    const lower = day.toLowerCase();
    if (lower === "tomorrow") start = today + 24 * 60 * 60_000;
    else if (/^\d{4}-\d{2}-\d{2}$/.test(day)) start = startOfDay(Date.parse(`${day}T12:00:00Z`), tz);
    const end = start + 24 * 60 * 60_000;
    const time = (at: number) => new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, ...(tz ? { timeZone: tz } : {}) }).format(at);
    const lines: string[] = [];
    if (start <= now && now < end) {
      for (const run of this.world.routineRuns(start, now).slice(0, 5)) lines.push(`ran ${time(run.at)} ${run.name}: ${run.status}`);
    }
    for (const item of this.world.upcoming(Math.max(start, now), end).slice(0, 8)) lines.push(`${time(item.at)} ${item.name}${item.kind === "call" ? " (bos call)" : ""}`);
    const head = lines.length ? lines.join("\n") : "nothing scheduled in bos.";
    return `${head}\ngoogle calendar isn't readable on the call yet; a job can check it.`;
  }

  private status(botId: string, topic: string): string {
    const words = topicWords(topic);
    if (!words.length) return "say which topic.";
    const lines: string[] = [];
    for (const thread of this.world.findThreads(words, 3)) {
      lines.push(`${thread.botName} · ${clip(thread.title, 60)} (${thread.state})${thread.last ? `: ${clip(plain(thread.last), 220)}` : ""}`);
    }
    const now = this.world.now();
    for (const run of this.world.routineRuns(now - 3 * 24 * 60 * 60_000, now)) {
      if (lines.length >= 4) break;
      if (score(`${run.name} ${run.output ?? ""}`, words) === 0) continue;
      lines.push(`routine ${run.name} ${run.status}${run.output ? `: ${clip(plain(run.output), 200)}` : ""}`);
    }
    if (lines.length < 2) {
      const memory = this.recallMemory(botId, topic);
      if (!memory.startsWith("nothing")) lines.push(`memory:\n${memory.split("\n").slice(0, 2).join("\n")}`);
    }
    return lines.length ? lines.join("\n") : `nothing on ${topic} in threads, routines or memory. a job can look it up.`;
  }

  private needsMe(callId: string): string {
    const items = this.world.needsMe().slice(0, 5);
    const now = this.world.now();
    for (const [id, row] of this.needsMeOrder) if (now - row.at > 60 * 60_000) this.needsMeOrder.delete(id);
    this.needsMeOrder.set(callId, { at: now, items });
    if (!items.length) return "nothing waiting on you.";
    return items.map((item, i) => {
      const kind = item.approval ? "approval (screen only)" : item.options?.length ? `choice: ${item.options.slice(0, 3).join(" / ")}` : "question";
      return `${i + 1}. ${item.botName}: ${clip(plain(item.title), 60)}. ${clip(plain(item.preview), 160)} [${kind}]`;
    }).join("\n");
  }

  private resolveItem(callId: string, item: string): VoiceNeedsMeItem | null {
    const listed = this.needsMeOrder.get(callId)?.items ?? this.world.needsMe().slice(0, 5);
    const n = Number.parseInt(/\d+/.exec(item)?.[0] ?? "", 10);
    const ordinal = ["first", "second", "third", "fourth", "fifth"].findIndex((word) => item.toLowerCase().includes(word));
    const picked = Number.isFinite(n) ? listed[n - 1] : ordinal >= 0 ? listed[ordinal] : listed.find((row) => row.id === item);
    if (!picked) return null;
    // still waiting? (it may have been answered on screen meanwhile)
    return this.world.needsMe().find((row) => row.id === picked.id) ?? null;
  }

  private async answerItem(callId: string, item: string, answer: string): Promise<string> {
    if (!answer) return "say the answer.";
    const target = this.resolveItem(callId, item);
    if (!target) return "that one isn't waiting any more.";
    // Tool approvals are how client messages, spend and prod writes are
    // gated: they stay a tap on screen, never a word on a call.
    if (target.approval) return SCREEN_ONLY;
    if (target.requestId) {
      const ok = await this.world.answerQuestion(target, answer);
      return ok ? "answered." : "couldn't answer that one; it's no longer open.";
    }
    await this.world.sendToThread({ botId: target.botId, threadId: target.threadId, text: answer, callId, sendId: voiceSendId("voiceans", callId, `${target.id}\n${answer}`) });
    return "answered.";
  }

  private async followUp(callId: string, jobId: string, topic: string, text: string): Promise<string> {
    if (!text) return "say what to add.";
    let target: { botId: string; threadId: string } | null = null;
    if (jobId && this.state.jobs[jobId]) target = this.state.jobs[jobId];
    if (!target && topic) {
      const words = topicWords(topic);
      const fromCall = Object.values(this.state.jobs).filter((job) => job.callId === callId)
        .map((job) => ({ job, s: score(spoken(job.text), words) })).filter((row) => row.s > 0).sort((a, b) => b.s - a.s)[0]?.job;
      target = fromCall ?? null;
      // an older thread isn't this call's job: the ask gets its own new
      // thread that names it, instead of queueing behind that thread's work
      const older = fromCall ? null : this.world.findThreads(words, 1)[0];
      const ours = older && Object.values(this.state.jobs).find((job) => job.callId === callId && job.threadId === older.threadId);
      if (ours) target = ours;
      else if (older) return this.aboutThread(callId, older, text);
    }
    if (!target) {
      const latest = Object.values(this.state.jobs).filter((job) => job.callId === callId).sort((a, b) => b.at - a.at)[0];
      if (latest && !jobId && !topic) target = latest;
    }
    if (!target) return "couldn't tell which job. say its name.";
    await this.world.sendToThread({ botId: target.botId, threadId: target.threadId, text, callId, sendId: voiceSendId("voicefu", callId, `${target.threadId}\n${text}`) });
    const thread = this.world.thread(target.botId, target.threadId);
    return `added to ${thread ? clip(thread.title, 50) : "that job"}.`;
  }

  private async aboutThread(callId: string, thread: VoiceThreadView, text: string): Promise<string> {
    const said = clip(text, MAX_JOB_CHARS - 200);
    const jobId = `vfu-${createHash("sha256").update(`${callId}\n${thread.threadId}\n${said}`).digest("hex").slice(0, 24)}`;
    const job = `${said}${ABOUT_THREAD}"${clip(thread.title, 80)}", thread id ${thread.threadId})`;
    const result = await this.oneJob(callId, thread.botId, { jobId, text: job, bot: thread.botId });
    if (result.status === "failed") return `couldn't start it: ${result.error ?? "unknown error"}`;
    return `started a new thread for that, about ${clip(thread.title, 50)}.`;
  }

  // ── after hang-up ───────────────────────────────────────────────────────

  private readonly cards = new Map<string, VoiceCallCard>();

  async end(request: VoiceCallEndRequest): Promise<VoiceCallEndResponse> {
    const done = this.state.calls[request.callId];
    if (done) return { threadId: done.threadId, messageId: done.messageId };
    let pending = this.inflightEnds.get(request.callId);
    if (!pending) {
      pending = this.writeEnd(request).finally(() => this.inflightEnds.delete(request.callId));
      this.inflightEnds.set(request.callId, pending);
    }
    return pending;
  }

  private async writeEnd(request: VoiceCallEndRequest): Promise<VoiceCallEndResponse> {
    const transcript = (request.transcript ?? [])
      .filter((line) => (line.role === "user" || line.role === "bot") && typeof line.text === "string" && line.text.trim())
      .slice(-MAX_TRANSCRIPT_LINES)
      .map((line) => ({ role: line.role, text: line.text.trim().slice(0, MAX_LINE_CHARS), ...(typeof line.at === "number" ? { at: line.at } : {}) }));
    const jobs = (request.jobs ?? []).filter((job) => isVoiceJobId(job.jobId)).slice(0, 50).map((job) => {
      const known = this.state.jobs[job.jobId];
      const botId = known?.botId ?? job.botId ?? (job.bot ? this.route(request.botId, job.bot).id : undefined);
      return {
        jobId: job.jobId,
        text: spoken(known?.text ?? job.text ?? "").slice(0, MAX_JOB_CHARS),
        ...(botId ? { botId, botName: this.botName(botId) } : {}),
        ...(known?.threadId ?? job.threadId ? { threadId: known?.threadId ?? job.threadId } : {}),
        status: known ? "sent" as const : job.status,
      };
    });
    const confirmed = jobs.filter((job) => job.status !== "cancelled" && job.status !== "said").map((job) => job.text);
    let summary = "";
    let facts: string[] = [];
    if (transcript.some((line) => line.role === "user")) {
      try {
        const made = await this.world.summarize?.(transcript, confirmed);
        if (made) {
          summary = clip(made.summary, 240);
          facts = made.facts.map((fact) => clip(fact, 200)).filter(Boolean).slice(0, 6);
        }
      } catch {
        /* fallback below */
      }
    }
    if (!summary) summary = fallbackSummary(transcript, confirmed);
    const card: VoiceCallCard = {
      callId: request.callId,
      botId: request.botId,
      startedAt: request.startedAt,
      seconds: Math.max(0, Math.round(request.seconds)),
      transcript,
      jobs,
      summary,
      drops: Math.max(0, request.metrics?.drops ?? 0),
      resumes: Math.max(0, request.metrics?.resumes ?? 0),
    };
    // a retry may have landed while the summary was being made
    const raced = this.state.calls[request.callId];
    if (raced) return { threadId: raced.threadId, messageId: raced.messageId };
    const posted = this.world.postCard(request.botId, card, voiceCardText(card));
    this.cards.set(request.callId, card);
    const now = this.world.now();
    this.state.calls[request.callId] = { botId: request.botId, threadId: posted.threadId, messageId: posted.messageId, at: now };
    const summaries = [...(this.state.summaries[request.botId] ?? []), { at: request.startedAt || now, callId: request.callId, summary }];
    this.state.summaries[request.botId] = summaries.slice(-SUMMARIES_PER_BOT);
    this.save();
    this.briefs.delete(request.botId);
    this.needsMeOrder.delete(request.callId);
    if (transcript.some((line) => line.role === "user")) {
      try {
        this.noteInMemory(request.botId, request.startedAt || now, card.seconds, summary, facts, confirmed);
      } catch {
        /* the card is written; memory is best effort */
      }
    }
    return posted;
  }

  private noteInMemory(botId: string, at: number, seconds: number, summary: string, facts: string[], jobs: string[]): void {
    const tz = this.world.timeZone;
    const stamp = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false, ...(tz ? { timeZone: tz } : {}) }).format(at).replace(",", "");
    const entry = [
      `## ${stamp} call (${formatSeconds(seconds)})`,
      `- ${summary}`,
      ...facts.map((fact) => `- ${fact}`),
      ...jobs.map((job) => `- job: ${clip(job, 160)}`),
    ].join("\n");
    this.world.writeMemory(botId, VOICE_NOTES_PATH, (before) => {
      const head = "# voice calls\n\nwhat came up on calls, newest last. written by bos after each call.\n";
      const body = before.startsWith("# voice calls") ? before.slice(before.indexOf("\n## ") >= 0 ? before.indexOf("\n## ") + 1 : before.length) : before;
      let entries = `${body.trim()}\n\n${entry}`.trim();
      while (entries.length > VOICE_NOTES_MAX_CHARS) {
        const cut = entries.indexOf("\n## ", 1);
        if (cut < 0) break;
        entries = entries.slice(cut + 1);
      }
      return `${head}\n${entries}\n`;
    });
  }

  /** good / bad from the card. */
  rate(callId: string, good: boolean): boolean {
    const call = this.state.calls[callId];
    const card = this.card(callId);
    if (!call || !card) return false;
    card.rating = good ? "good" : "bad";
    this.world.patchCard(call.botId, call.threadId, call.messageId, card, voiceCardText(card));
    return true;
  }

  private card(callId: string): VoiceCallCard | null {
    const cached = this.cards.get(callId);
    if (cached) return cached;
    const call = this.state.calls[callId];
    const stored = call ? this.world.readCard(call.threadId, call.messageId) : null;
    if (stored) this.cards.set(callId, stored);
    return stored;
  }

  cardLocation(callId: string): CallRow | undefined {
    return this.state.calls[callId];
  }
}

/** The same words on the same call are one send: a client that retries a
 * tool call after a timeout doesn't add them twice. */
function voiceSendId(prefix: string, callId: string, key: string): string {
  return `${prefix}-${callId.slice(0, 40)}-${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
}

function jobTitle(text: string): string {
  const words = plain(text).replace(/^(please|can you|could you|pls|tolong)\s+/i, "").split(/\s+/).slice(0, 7).join(" ");
  return `voice · ${clip(words, 60)}`;
}

/** Midnight of `at`'s day in `tz` (or local), as epoch ms. */
export function startOfDay(at: number, tz?: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, ...(tz ? { timeZone: tz } : {}) })
    .formatToParts(at).reduce<Record<string, string>>((acc, part) => ({ ...acc, [part.type]: part.value }), {});
  const hour = Number(parts.hour) % 24;
  const sinceMidnight = ((hour * 60 + Number(parts.minute)) * 60 + Number(parts.second)) * 1000 + (at % 1000);
  return at - sinceMidnight;
}

// ── post-call summary through xAI's text API ──────────────────────────────

const XAI_API = "https://api.x.ai";
const MODEL_TTL_MS = 6 * 60 * 60_000;

/** Pick a fast grok text model from xAI's own list (no hard-coded id that
 * could be retired), then ask it for one line plus the facts worth keeping.
 * Any failure returns null and the caller writes a plain summary instead. */
export function createXaiSummarizer(key: () => string | undefined, fetchImpl: typeof fetch = fetch, apiBase = XAI_API) {
  let model: { key: string; id: string | null; at: number } | null = null;
  const pickModel = async (apiKey: string): Promise<string | null> => {
    if (model && model.key === apiKey && Date.now() - model.at < MODEL_TTL_MS) return model.id;
    let id: string | null = null;
    try {
      const res = await fetchImpl(`${apiBase}/v1/models`, { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(10_000) });
      if (res.ok) {
        const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
        const ids = (body.data ?? []).map((row) => row.id).filter((value): value is string => typeof value === "string");
        const text = ids.filter((name) => /^grok/i.test(name) && !/voice|image|vision|imagine|video|embed|tts|transcribe|realtime/i.test(name));
        id = text.find((name) => /fast/i.test(name) && /non-reasoning/i.test(name))
          ?? text.find((name) => /fast/i.test(name))
          ?? text.find((name) => /mini/i.test(name))
          ?? null;
      }
    } catch {
      id = null;
    }
    model = { key: apiKey, id, at: Date.now() };
    return id;
  };
  return async (transcript: VoiceTranscriptLine[], jobs: string[]): Promise<{ summary: string; facts: string[] } | null> => {
    const apiKey = key()?.trim();
    if (!apiKey) return null;
    const id = await pickModel(apiKey);
    if (!id) return null;
    const lines = transcript.map((line) => `${line.role === "user" ? "caller" : "bot"}: ${line.text}`).join("\n").slice(-12_000);
    const res = await fetchImpl(`${apiBase}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({
        model: id,
        temperature: 0.2,
        max_tokens: 400,
        messages: [
          {
            role: "system",
            content: "You summarise a phone call between a person and their AI assistant. Reply with JSON only: {\"summary\": one lowercase line under 25 words saying what the call was about and what was decided, \"facts\": up to 5 short lowercase lines worth remembering next call (decisions, names, numbers, preferences, things they said they'd do). No facts about the assistant itself. Empty list if nothing durable.}",
          },
          { role: "user", content: `${lines}${jobs.length ? `\n\njobs confirmed on the call:\n${jobs.map((job) => `- ${job}`).join("\n")}` : ""}` },
        ],
      }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string") return null;
    const json = content.slice(content.indexOf("{"), content.lastIndexOf("}") + 1);
    try {
      const parsed = JSON.parse(json) as { summary?: unknown; facts?: unknown };
      if (typeof parsed.summary !== "string" || !parsed.summary.trim()) return null;
      const facts = Array.isArray(parsed.facts) ? parsed.facts.filter((fact): fact is string => typeof fact === "string" && Boolean(fact.trim())) : [];
      return { summary: parsed.summary.trim(), facts };
    } catch {
      return null;
    }
  };
}
