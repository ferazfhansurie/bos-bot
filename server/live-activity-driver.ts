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

export interface LiveBot { id: string; name: string; color: string; mascotBody?: string; mascotEyes?: string }

export interface LiveView {
  kind: "working" | "needsYou";
  threadId: string;
  line: string;
  symbol: string;
  face: string;
  since: number;
  otherThreads: number;
}

const ACTIVE = new Set(["thinking", "tool", "typing", "waiting"]);

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
      : { line: "thinking", symbol: "ellipsis", face: "thinking" };
    views.set(botId, { kind: head.state === "waiting" ? "needsYou" : "working", threadId: head.threadId, ...step,
      since: Math.min(...list.filter(item => item.threadId === head.threadId).map(item => item.since)), otherThreads: list.length - 1 });
  }
  return views;
}

/** Seconds since 2001-01-01: the way ActivityKit's decoder reads a Date. */
const appleDate = (ms: number) => ms / 1000 - 978_307_200;

export function liveContent(bot: LiveBot, view: LiveView, title?: string): Record<string, unknown> {
  return {
    face: view.face, kind: view.kind, headline: view.kind === "needsYou" ? `${bot.name} needs you` : `${bot.name} is working`,
    line: view.line, threadId: view.threadId, options: [], isPermission: false, since: appleDate(view.since), symbol: view.symbol,
    ...(title ? { threadTitle: title } : {}), ...(view.otherThreads > 0 ? { otherThreads: view.otherThreads } : {}),
  };
}

export interface LiveDriverDeps {
  bot: (id: string) => LiveBot | undefined;
  title: (botId: string, threadId: string) => string | undefined;
  /** What the phone can take for this bot right now. A phone whose app is
   * on screen counts as neither: the app drives its own island then. */
  reach: (botId: string) => { activity: boolean; start: boolean };
  send: (push: LiveActivityPush) => Promise<void>;
  now?: () => number;
  /** A step change alone waits this long; kind and thread changes go now. */
  stepEvery?: number;
  debounce?: number;
}

interface Sent { view: LiveView; at: number; title?: string; started: boolean }

export class LiveActivityDriver {
  private sent = new Map<string, Sent>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private latest: readonly ActivityItem[] = [];

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

  async flush(): Promise<void> {
    const views = liveViews(this.latest);
    const now = this.now();
    const sends: Promise<void>[] = [];
    let recheck = false;
    for (const [botId, view] of views) {
      const bot = this.deps.bot(botId);
      if (!bot) continue;
      const before = this.sent.get(botId);
      const reach = this.deps.reach(botId);
      const title = this.deps.title(botId, view.threadId);
      const content = liveContent(bot, view, title);
      const stale = Math.floor(now / 1000) + 30 * 60;
      const attributes = { botId: bot.id, threadId: view.threadId, name: bot.name, color: bot.color,
        ...(bot.mascotBody ? { mascotBody: bot.mascotBody } : {}), ...(bot.mascotEyes ? { mascotEyes: bot.mascotEyes } : {}) };
      const asks = view.kind === "needsYou" && before?.view.kind !== "needsYou";
      const alert = asks ? { title: `${bot.name} needs you`, body: title ? `waiting on you in ${title}` : "waiting on you" } : undefined;
      if (reach.activity) {
        // the island is on the phone: keep it current
        const changed = !before || before.view.kind !== view.kind || before.view.threadId !== view.threadId
          || before.view.otherThreads !== view.otherThreads || before.title !== title;
        const stepped = before?.view.line !== view.line;
        if (!changed && !stepped) continue;
        if (!changed && before && now - before.at < (this.deps.stepEvery ?? 15_000)) { recheck = true; continue; }
        sends.push(this.deps.send({ event: "update", attributes, content, staleDate: stale, priority: changed || asks ? 10 : 5, ...(alert ? { alert } : {}) }));
        this.sent.set(botId, { view, at: now, title, started: true });
      } else if (reach.start && !before?.started) {
        sends.push(this.deps.send({ event: "start", attributes, content, staleDate: stale, priority: 10,
          alert: alert ?? { title: `${bot.name} is working`, body: title ?? view.line } }));
        this.sent.set(botId, { view, at: now, title, started: true });
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
      const done = { ...liveContent(bot, before.view, before.title), kind: "done", face: "happy", headline: `${bot.name} is done`,
        line: "finished", symbol: "checkmark", endedAt: appleDate(now) };
      delete (done as { otherThreads?: number }).otherThreads;
      sends.push(this.deps.send({ event: "end", attributes: { botId: bot.id, threadId: before.view.threadId, name: bot.name, color: bot.color },
        content: done, dismissalDate: Math.floor(now / 1000) + 2 * 60, priority: 10 }));
    }
    if (recheck) this.observe(this.latest);
    await Promise.all(sends);
  }
}
