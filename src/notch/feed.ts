// The notch's snapshot, built from what the main window already holds: the
// bots, the live activity feed and the needs-me inbox. Pure, so the rules
// that decide what reaches the top of the screen are tested on their own.
import type { ActivityEntry, ActivityState } from "@/lib/activity-feed";
import type { InboxItem } from "@/lib/inbox";
import type { AttentionPreferences } from "@/lib/attention-preferences";
import type { Bot, Group } from "@/state/store";
import type { NotchAsk, NotchBot, NotchClock, NotchMoment, NotchSnapshot } from "./types";
import { resolveMausColor } from "../../shared/glyph-faces";

/** waiting needs the person most; then whatever is visibly moving */
const RANK: Record<ActivityState, number> = { waiting: 0, tool: 1, typing: 2, thinking: 3, failed: 4, stopped: 5, idle: 6 };
const LIVE = new Set<ActivityState>(["waiting", "tool", "typing", "thinking"]);
export const isLive = (state: ActivityState | undefined) => Boolean(state && LIVE.has(state));

/** how long a finished or failed turn stays at the notch; both halves read it */
export const MOMENT_MS = 6_000;

const SHELF_RESTING = 4;
const MAX_WORKING = 12;
const PREVIEW = 280;

type NotchBotRecord = Pick<Bot, "id" | "name" | "color" | "mascotBody" | "threadId" | "tasks" | "hidden" | "busy" | "activity"> & { messages?: Bot["messages"] };
type NotchGroupRecord = Pick<Group, "id" | "name" | "threadId" | "tasks">;

export interface NotchInputs {
  bots: readonly NotchBotRecord[];
  groups: readonly NotchGroupRecord[];
  activity: ReadonlyMap<string, ActivityEntry>;
  inbox: readonly InboxItem[];
  /** the conversation on screen in a focused app window; it stays out */
  hiddenThreadId: string | null;
  moments: readonly NotchMoment[];
  prefs: Pick<AttentionPreferences, "approval" | "question" | "sound">;
}

export function threadTitle(threadId: string, bots: readonly NotchBotRecord[], groups: readonly NotchGroupRecord[]): string {
  for (const owner of [...bots, ...groups]) {
    const task = owner.tasks?.find((candidate) => candidate.threadId === threadId);
    if (task?.title) return task.title;
  }
  return groups.find((group) => group.threadId === threadId || group.tasks?.some((task) => task.threadId === threadId))?.name ?? "";
}

const lastActive = (bot: NotchBotRecord) =>
  Math.max(0, ...(bot.tasks ?? []).map((task) => task.lastActivityAt ?? task.lastUserMessageAt ?? task.createdAt ?? 0));

const clip = (value: string, max: number) => {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
};

/** One row per bot: its most urgent live thread, if any. */
function liveRows(inputs: NotchInputs): NotchBot[] {
  const best = new Map<string, ActivityEntry>();
  for (const entry of inputs.activity.values()) {
    if (!isLive(entry.state) || entry.threadId === inputs.hiddenThreadId) continue;
    const current = best.get(entry.botId);
    if (!current || RANK[entry.state] < RANK[current.state] || (RANK[entry.state] === RANK[current.state] && entry.since < current.since)) {
      best.set(entry.botId, entry);
    }
  }
  const rows: NotchBot[] = [];
  for (const bot of inputs.bots) {
    if (bot.hidden) continue;
    const entry = best.get(bot.id);
    if (entry) {
      rows.push(row(bot, entry.threadId, entry.state, entry.since, inputs, entry));
      continue;
    }
    // an older server without the feed still reports busy tasks
    const task = (bot.tasks ?? []).find((candidate) =>
      candidate.threadId !== inputs.hiddenThreadId &&
      !inputs.activity.has(`${bot.id}\u0000${candidate.threadId}`) &&
      (candidate.activity === "waiting-on-you" || candidate.activity === "working" || candidate.busy));
    if (task) rows.push(row(bot, task.threadId, task.activity === "waiting-on-you" ? "waiting" : "thinking", task.turnStartedAt ?? 0, inputs));
  }
  return rows.sort((a, b) => RANK[a.state] - RANK[b.state] || a.since - b.since || a.id.localeCompare(b.id)).slice(0, MAX_WORKING);
}

function row(bot: NotchBotRecord, threadId: string, state: ActivityState, since: number, inputs: NotchInputs, entry?: ActivityEntry): NotchBot {
  return {
    ...jobFields(entry),
    id: bot.id,
    name: bot.name,
    color: bot.color,
    body: bot.mascotBody ?? null,
    threadId,
    title: clip(threadTitle(threadId, inputs.bots, inputs.groups), 80),
    state,
    since,
  };
}

/** The job clock, step and plan a newer server folds onto a busy thread. */
function jobFields(entry: ActivityEntry | undefined): Pick<NotchBot, "jobSince" | "step" | "plan"> {
  if (!entry || !isLive(entry.state)) return {};
  const plan = entry.state !== "waiting" && entry.stepCount && entry.stepCount >= 2 && entry.stepIndex && entry.stepIndex >= 1
    ? { index: Math.min(entry.stepIndex, entry.stepCount), count: entry.stepCount } : undefined;
  return {
    ...(entry.jobSince ? { jobSince: entry.jobSince } : {}),
    ...(entry.step && entry.state !== "waiting" ? { step: clip(entry.step, 40) } : {}),
    ...(plan ? { plan } : {}),
  };
}

/** What the menu bar clock shows (electron/menubar-clock.mjs): the most
 * urgent working bot, its plan and when its job began. */
export function menuBarClock(working: readonly NotchBot[]): NotchClock | null {
  const head = working[0];
  if (!head) return null;
  return {
    botId: head.id, threadId: head.threadId, name: head.name, color: resolveMausColor(head.color),
    needsYou: head.state === "waiting", start: head.jobSince ?? head.since,
    ...(head.plan ? { plan: head.plan } : {}), more: working.length - 1,
  };
}

/** The id an answer names: the row plus the exact request it is about. */
export const askKey = (item: Pick<InboxItem, "id" | "requestId" | "messageId">) =>
  `${item.id}#${item.requestId ?? ""}#${item.messageId ?? ""}`;

/** An inbox row the notch can answer in place: a tool approval, a question
 * with written choices, or a plain live question that takes typed words.
 * Proposals (skills, routines, profiles, team setup) and question sets need
 * their full card, and reports and unread rows are not a bot blocked on the
 * person, so none of those reach the notch. */
export function notchAsk(item: InboxItem, prefs: NotchInputs["prefs"]): NotchAsk | null {
  if (item.leadAction || (item.kind !== "waiting-on-you" && item.kind !== "question")) return null;
  const approval = Boolean(item.approval && item.requestId);
  const options = !approval && item.options?.length && (item.requestId || item.messageId)
    ? item.options.slice(0, 4).map((value) => ({ label: clip(value, 60), value }))
    : undefined;
  const freeText = !approval && !options && Boolean(item.freeText && item.requestId && !item.groupId);
  if (!approval && !options && !freeText) return null;
  const kind = approval ? "approval" : "question";
  return {
    id: askKey(item),
    botId: item.botId,
    threadId: item.threadId,
    kind,
    title: clip(item.title, 80),
    preview: clip(item.preview, PREVIEW),
    ...(options ? { options } : {}),
    freeText,
    chime: prefs[kind] && prefs.sound !== "none",
    at: item.at,
  };
}

export function buildNotchSnapshot(inputs: NotchInputs): NotchSnapshot {
  const visible = inputs.bots.filter((bot) => !bot.hidden);
  const working = liveRows(inputs);
  const live = new Set(working.map((bot) => bot.id));
  const resting = visible
    .filter((bot) => !live.has(bot.id))
    .sort((a, b) => lastActive(b) - lastActive(a))
    .slice(0, SHELF_RESTING)
    .map((bot) => row(bot, bot.tasks?.[0]?.threadId ?? bot.threadId, "idle", 0, inputs));
  const asks = inputs.inbox
    .filter((item) => item.threadId !== inputs.hiddenThreadId)
    .flatMap((item) => notchAsk(item, inputs.prefs) ?? [])
    .sort((a, b) => a.at - b.at);
  const bots: NotchSnapshot["bots"] = {};
  for (const bot of visible) bots[bot.id] = { id: bot.id, name: bot.name, color: bot.color, body: bot.mascotBody ?? null };
  return {
    working,
    clock: menuBarClock(working),
    shelf: [...working, ...resting],
    bots,
    asks,
    moments: inputs.moments
      .filter((moment) => moment.threadId !== inputs.hiddenThreadId && bots[moment.botId])
      .map((moment) => {
        const preview = momentPreview(moment, inputs.bots);
        return preview ? { ...moment, preview } : moment;
      }),
  };
}

const MOMENT_PREVIEW = 140;

/** What the bot said last in a finished thread, when that thread is the one
 * the app holds messages for. Its reply can land a beat after the turn
 * ends, so this is read on every snapshot rather than kept on the moment. */
export function momentPreview(moment: Pick<NotchMoment, "botId" | "threadId" | "kind">, bots: readonly NotchBotRecord[]): string {
  if (moment.kind !== "done") return "";
  const bot = bots.find((candidate) => candidate.id === moment.botId);
  if (!bot || bot.threadId !== moment.threadId || !bot.messages?.length) return "";
  for (let index = bot.messages.length - 1; index >= 0; index -= 1) {
    const message = bot.messages[index]!;
    if (message.role === "user") return "";
    if (message.kind === "text" && message.text?.trim()) return clip(message.text.replace(/[*_`#>]+/g, ""), MOMENT_PREVIEW);
  }
  return "";
}

/** A finished or failed turn worth a moment at the notch: a live thread
 * that came to rest, or broke. A stop the person pressed is not a moment,
 * and a routine's quiet success is not one either. */
export function momentFor(
  previous: ActivityState | undefined,
  next: ActivityEntry,
  routineThread: boolean,
): NotchMoment["kind"] | null {
  if (!isLive(previous)) return null;
  if (next.state === "failed") return "failed";
  if (next.state === "idle" && !routineThread) return "done";
  return null;
}
