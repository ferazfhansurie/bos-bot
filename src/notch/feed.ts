// The notch's snapshot, built from what the main window already holds: the
// bots, the live activity feed and the needs-me inbox. Pure, so the rules
// that decide what reaches the top of the screen are tested on their own.
import type { ActivityEntry, ActivityState } from "@/lib/activity-feed";
import type { InboxItem } from "@/lib/inbox";
import type { AttentionPreferences } from "@/lib/attention-preferences";
import type { Bot, Group } from "@/state/store";
import type { NotchAsk, NotchBot, NotchMoment, NotchSnapshot } from "./types";

/** waiting needs the person most; then whatever is visibly moving */
const RANK: Record<ActivityState, number> = { waiting: 0, tool: 1, typing: 2, thinking: 3, failed: 4, stopped: 5, idle: 6 };
const LIVE = new Set<ActivityState>(["waiting", "tool", "typing", "thinking"]);
export const isLive = (state: ActivityState | undefined) => Boolean(state && LIVE.has(state));

const SHELF_RESTING = 4;
const MAX_WORKING = 12;
const PREVIEW = 280;

type NotchBotRecord = Pick<Bot, "id" | "name" | "color" | "mascotBody" | "threadId" | "tasks" | "hidden" | "busy" | "activity">;
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
      rows.push(row(bot, entry.threadId, entry.state, entry.since, inputs));
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

function row(bot: NotchBotRecord, threadId: string, state: ActivityState, since: number, inputs: NotchInputs): NotchBot {
  return {
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
    shelf: [...working, ...resting],
    bots,
    asks,
    moments: inputs.moments.filter((moment) => moment.threadId !== inputs.hiddenThreadId && bots[moment.botId]),
  };
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
