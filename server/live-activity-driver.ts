// The phone's "bos is working" island, driven from here.
//
// The app starts a bot's Live Activity itself while it is on screen, but it
// is the server that knows a turn is running once the phone is locked or the
// app is closed. This folds the same activity snapshot the desktop sidebar
// reads into one island per bot and sends ActivityKit pushes: start when a
// bot begins, update when what it is doing changes, end with a done card
// when it settles. Most urgent wins per bot, like the app's own rule.
import type { ActivityItem } from "../shared/activity.ts";
import type { LiveActivityPush } from "./apns-push.ts";
import type { OptionCardData } from "../shared/wire.ts";
import type { LiveStep } from "./live-step.ts";

export interface LiveBot { id: string; name: string; color: string; mascotBody?: string; mascotEyes?: string }

export interface LiveView {
  kind: "working" | "needsYou";
  threadId: string;
  line: string;
  symbol: string;
  face: string;
  /** When this job began: the first time its thread was seen busy. One
   * clock for the whole job, not reset by each thinking/tool/typing change. */
  since: number;
  otherThreads: number;
  /** When the step line last changed, for the step's own sweep. */
  stepSince?: number;
  stepIndex?: number;
  stepCount?: number;
  planStep?: string;
}

const ACTIVE = new Set(["thinking", "tool", "typing", "waiting"]);
/** The state's own lines: a real step from the tools replaces them, and
 * they never hold the card over a real one. */
const GENERIC = new Set(["waiting for you", "working on it", "writing the reply", "reading your message"]);

/** One island per bot: a thread waiting on you beats one that is working,
 * then the most recent. */
export function liveViews(items: readonly ActivityItem[]): Map<string, LiveView> {
  const byBot = new Map<string, ActivityItem[]>();
  for (const item of items) if (ACTIVE.has(item.state)) byBot.set(item.botId, [...(byBot.get(item.botId) ?? []), item]);
  const views = new Map<string, LiveView>();
  for (const [botId, list] of byBot) {
    const head = [...list].sort((a, b) => Number(b.state === "waiting") - Number(a.state === "waiting") || b.since - a.since)[0];
    const step = head.state === "waiting" ? { line: "waiting for you", symbol: "hand.raised.fill", face: "listening" }
      : head.state === "tool" ? { line: "working on it", symbol: "terminal", face: "working" }
      : head.state === "typing" ? { line: "writing the reply", symbol: "text.bubble", face: "working" }
      : { line: "reading your message", symbol: "text.magnifyingglass", face: "thinking" };
    views.set(botId, { kind: head.state === "waiting" ? "needsYou" : "working", threadId: head.threadId, ...step,
      since: Math.min(...list.filter(item => item.threadId === head.threadId).map(item => item.since)), otherThreads: list.length - 1 });
  }
  return views;
}

/** Seconds since 2001-01-01: the way ActivityKit's decoder reads a Date. */
const appleDate = (ms: number) => ms / 1000 - 978_307_200;

/** The ask a lock-screen button may answer: one live request with plain
 * choices. Anything that needs its full card (skills, proposals, questions)
 * is left off, so the island only opens the thread for it. */
export interface LiveAsk { requestId: string; options: string[]; isPermission: boolean; line?: string }

/** The newest open live ask in a thread's tail that a lock-screen button
 * can answer safely: a tool approval or a plain choice. "Always allow" stays
 * in the app, where the grant it remembers is visible. */
export function liveAsk(messages: readonly { card?: Partial<OptionCardData> }[]): LiveAsk | undefined {
  const card = [...messages].reverse().find(message => message.card?.requestId && !message.card.answered && !message.card.dismissed)?.card;
  if (!card?.requestId) return undefined;
  if (card.skillRequest || card.routineRequest || card.profileRequest || card.teamSetupRequest || card.questionRequest || card.outboundReview) return undefined;
  const options = (card.options ?? []).filter(option => typeof option === "string" && option.trim()
    && option.trim().toLowerCase() !== "always allow").slice(0, 3);
  if (!options.length) return undefined;
  const line = [card.title, card.subtitle].filter(Boolean).join(" · ").slice(0, 120);
  return { requestId: card.requestId, options, isPermission: Boolean(card.tool), ...(line ? { line } : {}) };
}

/** Every busy bot in one line for the car: "3 working · 1 needs you", or
 * undefined with a single bot. Same words as the app's CarGlance. */
export function liveSummary(views: ReadonlyMap<string, LiveView>): string | undefined {
  if (views.size <= 1) return undefined;
  const waiting = [...views.values()].filter(view => view.kind === "needsYou").length;
  const working = views.size - waiting;
  return [working ? `${working} working` : "", waiting ? `${waiting} need${waiting === 1 ? "s" : ""} you` : ""].filter(Boolean).join(" · ");
}

/** The first readable line of a reply, as the done card shows it; the
 * app's replyFirstLine. */
export function replyFirstLine(text: string | undefined, limit = 120): string {
  for (const raw of (text ?? "").split("\n")) {
    const line = raw.trim().replace(/^[#>\-*`]+/, "").replaceAll("**", "").replaceAll("`", "").trim();
    if (line) return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
  }
  return "";
}

/** The bot's reply that ended a turn, for the done card: the thread's last
 * message when it is the bot's text since the turn began. */
export function liveResult(messages: readonly { role: string; kind: string; text?: string; at?: number }[], since: number): string | undefined {
  const last = [...messages].reverse().find(message => message.kind !== "digest");
  if (!last || last.role !== "bot" || last.kind !== "text" || (last.at ?? 0) < since - 1_000) return undefined;
  return replyFirstLine(last.text) || undefined;
}

/** How high iOS ranks this activity among several (CarPlay shows the top
 * one): a bot that needs you, then work, then a done card. */
const relevance = (kind: string) => kind === "needsYou" ? 80 : kind === "working" ? 50 : 10;

export function liveContent(bot: LiveBot, view: LiveView, title?: string, ask?: LiveAsk): Record<string, unknown> {
  const answer = view.kind === "needsYou" && ask?.requestId && ask.options.length ? ask : undefined;
  return {
    face: view.face, kind: view.kind, headline: view.kind === "needsYou" ? `${bot.name} needs you` : `${bot.name} is working`,
    line: answer?.line || view.line, threadId: view.threadId,
    ...(answer ? { requestId: answer.requestId } : {}), options: answer?.options ?? [], isPermission: answer?.isPermission ?? false,
    since: appleDate(view.since), jobSince: appleDate(view.since), symbol: view.symbol,
    ...(view.stepSince ? { stepSince: appleDate(view.stepSince) } : {}),
    ...(view.stepIndex && view.stepCount ? { stepIndex: view.stepIndex, stepCount: view.stepCount } : {}),
    ...(view.planStep ? { planStep: view.planStep } : {}),
    ...(title ? { threadTitle: title } : {}), ...(view.otherThreads > 0 ? { otherThreads: view.otherThreads } : {}),
  };
}

export interface LiveDriverDeps {
  bot: (id: string) => LiveBot | undefined;
  /** The card's title; `since` is when the job began (./live-title.ts). */
  title: (botId: string, threadId: string, since: number) => string | undefined;
  /** What the phone can take for this bot right now. A phone whose app is
   * on screen counts as neither: the app drives its own island then. */
  reach: (botId: string) => { activity: boolean; start: boolean };
  send: (push: LiveActivityPush) => Promise<void>;
  /** bos bot 3.0 only (absent otherwise): the request a waiting bot's
   * lock-screen buttons answer. */
  ask?: (botId: string, threadId: string) => LiveAsk | undefined;
  /** The first line of the reply that ended a turn started at `since`, for
   * the done card. Absent or undefined, the card says "finished". */
  result?: (botId: string, threadId: string, since: number) => string | undefined;
  /** What a working bot is doing in plain words, from its thread's tail
   * since the job began (./live-step.ts). Undefined keeps the last real
   * step on the card. Absent, the card shows the generic state lines. */
  step?: (botId: string, threadId: string, since: number) => LiveStep | undefined;
  /** bos bot 3.0 only: true while the person is at the Mac. A working bot
   * then stays on the Mac and walks back from the phone; a bot that needs
   * you still goes to the phone. undefined (or absent) is today's rule. */
  present?: () => boolean | undefined;
  now?: () => number;
  /** A step change alone waits this long (default 4s, inside ActivityKit's
   * budget at priority 5); kind and thread changes go now. */
  stepEvery?: number;
  debounce?: number;
}

interface Sent { view: LiveView; at: number; title?: string; started: boolean; requestId?: string; summary?: string }

export class LiveActivityDriver {
  private sent = new Map<string, Sent>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private latest: readonly ActivityItem[] = [];
  /** `${botId}:${threadId}` → when that job began, while it stays busy. */
  private jobs = new Map<string, number>();

  private readonly deps: LiveDriverDeps;
  constructor(deps: LiveDriverDeps) { this.deps = deps; }

  private now() { return this.deps.now?.() ?? Date.now(); }

  /** Called with every activity snapshot; settles for a beat, then diffs. */
  observe(items: readonly ActivityItem[]): void {
    this.latest = items;
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, this.deps.debounce ?? 1_500);
    this.timer.unref?.();
  }

  /** Redraw from the last snapshot, e.g. once a job's title arrives. */
  refresh(): void { this.observe(this.latest); }

  /** One clock per job: a thread keeps the time it was first seen busy
   * until it goes quiet, whatever its state does in between. */
  private jobClock(now: number): void {
    const busy = new Set<string>();
    for (const item of this.latest) {
      if (!ACTIVE.has(item.state)) continue;
      const key = `${item.botId}:${item.threadId}`;
      busy.add(key);
      const seen = this.jobs.get(key);
      this.jobs.set(key, Math.min(seen ?? now, item.since || now));
    }
    for (const key of this.jobs.keys()) if (!busy.has(key)) this.jobs.delete(key);
  }

  /** The real step for a working view: from the thread's tools, else the
   * last real step this job showed, else the state's own line. */
  private stepped(botId: string, view: LiveView, before: Sent | undefined, now: number): LiveView {
    const since = this.jobs.get(`${botId}:${view.threadId}`) ?? view.since;
    const sameJob = before?.view.threadId === view.threadId && before.view.since === since;
    let next: LiveView = { ...view, since };
    if (view.kind === "working" && view.line !== "writing the reply") {
      let step: LiveStep | undefined;
      try { step = this.deps.step?.(botId, view.threadId, since); } catch { step = undefined; }
      if (step) next = { ...next, line: step.line, symbol: step.symbol, stepIndex: step.stepIndex, stepCount: step.stepCount, planStep: step.planStep };
      else if (sameJob && before.view.kind === "working" && !GENERIC.has(before.view.line)) {
        next = { ...next, line: before.view.line, symbol: before.view.symbol, stepIndex: before.view.stepIndex, stepCount: before.view.stepCount, planStep: before.view.planStep };
      }
    } else if (sameJob && before.view.stepCount) {
      next = { ...next, stepIndex: before.view.stepIndex, stepCount: before.view.stepCount, planStep: before.view.planStep };
    }
    next.stepSince = sameJob && before.view.line === next.line ? before.view.stepSince ?? since : now;
    return next;
  }

  async flush(): Promise<void> {
    const now = this.now();
    this.jobClock(now);
    const views = liveViews(this.latest);
    const sends: Promise<void>[] = [];
    let recheck = false;
    const atMac = this.deps.present?.() === true;
    const summary = liveSummary(views);
    for (const [botId, raw] of views) {
      const bot = this.deps.bot(botId);
      if (!bot) continue;
      const before = this.sent.get(botId);
      const view = this.stepped(botId, raw, before, now);
      const reach = this.deps.reach(botId);
      const title = this.deps.title(botId, view.threadId, view.since);
      const ask = view.kind === "needsYou" ? this.deps.ask?.(botId, view.threadId) : undefined;
      const content: Record<string, unknown> = { ...liveContent(bot, view, title, ask), ...(summary ? { summary } : {}) };
      const requestId = typeof content.requestId === "string" ? content.requestId : undefined;
      const stale = Math.floor(now / 1000) + 30 * 60;
      const attributes = { botId: bot.id, threadId: view.threadId, name: bot.name, color: bot.color,
        ...(bot.mascotBody ? { mascotBody: bot.mascotBody } : {}), ...(bot.mascotEyes ? { mascotEyes: bot.mascotEyes } : {}) };
      const asks = view.kind === "needsYou" && before?.view.kind !== "needsYou";
      const alert = asks ? { title: `${bot.name} needs you`, body: title ? `waiting on you in ${title}` : "waiting on you" } : undefined;
      const stayHome = atMac && view.kind === "working";
      if (reach.activity && stayHome && before?.started) {
        // the person is back at the Mac: the working bot walks back to it
        sends.push(this.deps.send({ event: "end", attributes, content, dismissalDate: Math.floor(now / 1000), priority: 5 }));
        this.sent.set(botId, { view, at: now, title, started: false });
        recheck = true;
      } else if (reach.activity) {
        // the island is on the phone: keep it current
        const changed = !before || before.view.kind !== view.kind || before.view.threadId !== view.threadId
          || before.view.otherThreads !== view.otherThreads || before.title !== title || before.requestId !== requestId;
        // the car's every-bot line rides along like a step
        const stepped = before?.view.line !== view.line || before?.view.stepIndex !== view.stepIndex || before?.summary !== summary;
        if (!changed && !stepped) continue;
        if (!changed && before && now - before.at < (this.deps.stepEvery ?? 4_000)) { recheck = true; continue; }
        sends.push(this.deps.send({ event: "update", attributes, content, staleDate: stale, priority: changed || asks ? 10 : 5,
          relevance: relevance(view.kind), ...(alert ? { alert } : {}) }));
        this.sent.set(botId, { view, at: now, title, started: true, requestId, summary });
      } else if (reach.start && !before?.started && !stayHome) {
        sends.push(this.deps.send({ event: "start", attributes, content, staleDate: stale, priority: 10, relevance: relevance(view.kind),
          alert: alert ?? { title: `${bot.name} is working`, body: title ?? view.line } }));
        this.sent.set(botId, { view, at: now, title, started: true, requestId, summary });
        // the phone answers with the activity's own token; keep checking
        recheck = true;
      } else {
        // the app is on screen and runs its own island, or the start is
        // still waiting for its token: remember where things stand
        if (!before?.started) this.sent.set(botId, { view, at: now, title, started: false });
        recheck = true;
      }
    }
    for (const [botId, before] of this.sent) {
      if (views.has(botId)) continue;
      this.sent.delete(botId);
      const bot = this.deps.bot(botId);
      if (!bot || !this.deps.reach(botId).activity) continue;
      let result: string | undefined;
      try { result = this.deps.result?.(botId, before.view.threadId, before.view.since); } catch { result = undefined; }
      const done = { ...liveContent(bot, before.view, before.title), kind: "done", face: "happy", headline: `${bot.name} is done`,
        line: result || "finished", symbol: "checkmark", endedAt: appleDate(now),
        ...(result ? { result } : {}), ...(before.view.stepCount ? { stepIndex: before.view.stepCount } : {}) };
      delete (done as { otherThreads?: number }).otherThreads;
      sends.push(this.deps.send({ event: "end", attributes: { botId: bot.id, threadId: before.view.threadId, name: bot.name, color: bot.color },
        content: done, dismissalDate: Math.floor(now / 1000) + 2 * 60, priority: 10, relevance: relevance("done") }));
    }
    if (recheck) this.observe(this.latest);
    await Promise.all(sends);
  }
}
