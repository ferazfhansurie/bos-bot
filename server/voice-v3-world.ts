// The live server behind a v3 voice call (server/voice-v3.ts): the store,
// threads, needs-me inbox, routines and memory, read the way the sidebar and
// list_threads read them. index.ts hands in the few functions that live
// there, so it only wires this up and routes to it.
import type { InboxItem, ThreadState, WireMessage as Message } from "../shared/wire.ts";
import type { RoutineRun } from "../shared/routines.ts";
import type { VoiceCallCard } from "../shared/voice-call.ts";
import type { BotRecord, Store, TaskRecord } from "./store.ts";
import type { VoiceCallOrigin } from "./voice-origin.ts";
import type { VoiceNeedsMeItem, VoiceThreadView, VoiceWorld } from "./voice-v3.ts";

export interface VoiceWorldDeps {
  store: Store;
  userName: () => string | undefined;
  threadState: (botId: string, task: TaskRecord) => ThreadState;
  inbox: () => { items: InboxItem[] };
  routineRuns: () => RoutineRun[];
  routines: () => Array<{ name: string; botId: string; enabled: boolean; nextRunAt: number | null }>;
  calendarCalls: () => Array<{ name: string; botIds: string[]; nextRunAt: number | null }>;
  readMemory: (botId: string, path: string) => string;
  memoryTopics: (botId: string) => string[];
  /** text and hash from one read, so a write can't miss a change in between */
  readMemoryDoc: (botId: string, path: string) => { text: string; hash?: string };
  /** throws when expectedHash no longer matches (or the store refuses) */
  writeMemory: (botId: string, path: string, text: string, expectedHash: string | undefined) => void;
  /** spend cap: throws when over */
  assertBudget: () => void;
  send: (botId: string, threadId: string, text: string, sendId: string, origin: VoiceCallOrigin) => Promise<unknown>;
  /** sendId already in the thread or waiting in its queue */
  accepted: (botId: string, threadId: string, sendId: string) => boolean;
  deleteThread: (botId: string, threadId: string) => void;
  /** a thread was created or changed off screen: tell the clients */
  botChanged: (botId: string) => void;
  answer: (item: InboxItem, answer: string) => Promise<boolean>;
}

/** Routine runs that only say "nothing new" are noise on a call. */
const QUIET = /^\s*(quiet|nothing_to_report|no change|no_change|nothing new)\b/i;

function lastBotLine(store: Store, threadId: string): string | undefined {
  const messages = store.messagesFor(threadId);
  for (let i = messages.length - 1; i >= 0 && i >= messages.length - 40; i -= 1) {
    const message = messages[i];
    if (message.role === "bot" && message.kind === "text" && message.text?.trim()) return message.text;
  }
  return undefined;
}

/** Anything without a plain question shape counts as an approval: screen only. */
function isApproval(item: InboxItem): boolean {
  return item.approval === true || !(item.requestId ? (item.freeText || item.options?.length) : true);
}

/** A thread holding nothing but call cards: what every call opened before
 * the calls thread existed. */
function cardOnly(messages: Message[]): boolean {
  return messages.length > 0 && messages.every((message) => message.voiceCall);
}

export function createVoiceWorld(deps: VoiceWorldDeps, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || undefined): VoiceWorld {
  const { store } = deps;
  /** The bot's one calls thread, opened on its first call. Opening it folds
   * the older one-thread-per-call cards in, oldest first, and archives those
   * threads (never deletes them). An archived calls thread comes back when
   * the next card marks it unread. */
  const callsThread = (botId: string): TaskRecord | null => {
    const existing = store.tasks(botId).find((task) => task.voiceCalls);
    if (existing) return existing;
    const task = store.createTask(botId, "calls", false);
    if (!task) return null;
    store.patchTask(botId, task.threadId, { voiceCalls: true });
    const old = store.tasks(botId)
      .filter((other) => other.threadId !== task.threadId && !other.busy && cardOnly(store.messagesFor(other.threadId)))
      .sort((a, b) => a.createdAt - b.createdAt);
    const now = Date.now();
    for (const other of old) {
      for (const message of store.messagesFor(other.threadId)) {
        store.appendMessage(task.threadId, { role: message.role, kind: message.kind, text: message.text, voiceCall: message.voiceCall, at: message.at });
      }
      store.patchTask(botId, other.threadId, { unread: false, ...(other.archivedAt === undefined ? { archivedAt: now } : {}) });
    }
    return store.taskByThread(botId, task.threadId) ?? task;
  };
  const visibleBots = (): BotRecord[] => store.bots.filter((bot) => !bot.hidden);
  const nameOf = (botId: string) => store.bot(botId)?.name ?? botId;
  const view = (bot: BotRecord, task: TaskRecord): VoiceThreadView => ({
    botId: bot.id,
    botName: bot.name,
    threadId: task.threadId,
    title: task.title,
    state: deps.threadState(bot.id, task),
    last: lastBotLine(store, task.threadId),
    at: task.lastActivityAt ?? task.createdAt,
  });
  const liveTasks = () => visibleBots().flatMap((bot) => store.tasks(bot.id)
    .filter((task) => !task.archivedAt && !task.routineRunId && !task.channelTransport)
    .map((task) => ({ bot, task })));

  return {
    now: () => Date.now(),
    timeZone,
    get userName() { return deps.userName(); },
    roster: () => visibleBots().map((bot) => ({ id: bot.id, name: bot.name })),
    memory: (botId, path) => {
      try {
        return deps.readMemory(botId, path);
      } catch {
        return "";
      }
    },
    memoryTopics: (botId) => {
      try {
        return deps.memoryTopics(botId);
      } catch {
        return [];
      }
    },
    writeMemory: (botId, path, update) => {
      // a bot writing the same doc in between makes the hash miss: read again
      // and redo the update once
      for (let attempt = 0; ; attempt += 1) {
        const doc = deps.readMemoryDoc(botId, path);
        try {
          deps.writeMemory(botId, path, update(doc.text), doc.hash);
          return;
        } catch (error) {
          if (attempt >= 1) throw error;
        }
      }
    },
    openWork: (limit) => liveTasks()
      .map(({ bot, task }) => view(bot, task))
      .filter((thread) => thread.state === "running" || thread.state === "queued" || thread.state === "waiting-on-you")
      .sort((a, b) => b.at - a.at)
      .slice(0, limit),
    findThreads: (words, limit) => {
      if (!words.length) return [];
      return liveTasks()
        .map(({ bot, task }) => {
          const title = task.title.toLowerCase();
          const hits = words.filter((word) => title.includes(word)).length;
          return { bot, task, hits };
        })
        .filter((row) => row.hits > 0)
        .sort((a, b) => b.hits - a.hits || (b.task.lastActivityAt ?? b.task.createdAt) - (a.task.lastActivityAt ?? a.task.createdAt))
        .slice(0, limit)
        .map(({ bot, task }) => view(bot, task));
    },
    thread: (botId, threadId) => {
      const bot = store.bot(botId);
      const task = bot ? store.taskByThread(botId, threadId) : undefined;
      return bot && task ? view(bot, task) : null;
    },
    needsMe: () => deps.inbox().items
      .filter((item) => (item.kind === "waiting-on-you" || item.kind === "question") && !item.groupId && !item.leadAction)
      .map((item): VoiceNeedsMeItem => ({
        id: item.id,
        botId: item.botId,
        botName: nameOf(item.botId),
        threadId: item.threadId,
        title: item.title,
        preview: item.preview,
        ...(item.messageId ? { messageId: item.messageId } : {}),
        ...(item.requestId ? { requestId: item.requestId } : {}),
        approval: isApproval(item),
        ...(item.options ? { options: item.options } : {}),
        ...(item.freeText ? { freeText: true } : {}),
      })),
    routineRuns: (from, to) => deps.routineRuns()
      .filter((run) => {
        const at = run.finishedAt ?? run.startedAt ?? run.scheduledFor;
        return at >= from && at <= to && ["completed", "failed", "waiting", "running"].includes(run.status)
          && !(run.status === "completed" && QUIET.test(run.output ?? ""));
      })
      .map((run) => ({ name: run.routineName, botName: nameOf(run.botId), status: run.status, at: run.finishedAt ?? run.startedAt ?? run.scheduledFor, ...(run.output ? { output: run.output } : {}) }))
      .sort((a, b) => b.at - a.at),
    upcoming: (from, to) => [
      ...deps.routines().filter((routine) => routine.enabled && routine.nextRunAt != null && routine.nextRunAt >= from && routine.nextRunAt < to)
        .map((routine) => ({ name: routine.name, at: routine.nextRunAt!, kind: "routine" as const })),
      ...deps.calendarCalls().filter((call) => call.nextRunAt != null && call.nextRunAt >= from && call.nextRunAt < to)
        .map((call) => ({ name: call.name, at: call.nextRunAt!, kind: "call" as const })),
    ].sort((a, b) => a.at - b.at),
    startJob: async ({ botId, title, text, callId, sendId, threadId, opened }) => {
      const reuse = threadId ? store.taskByThread(botId, threadId) : undefined;
      if (reuse && deps.accepted(botId, reuse.threadId, sendId)) return { threadId: reuse.threadId };
      deps.assertBudget();
      const task = reuse ?? store.createTask(botId, title, false);
      if (!task) throw new Error("couldn't open a thread for that job");
      opened?.(task.threadId);
      deps.botChanged(botId);
      try {
        await deps.send(botId, task.threadId, text, sendId, { kind: "voice_call", callId, job: text });
      } catch (error) {
        // nothing landed: don't leave an empty thread behind
        if (!reuse && !deps.accepted(botId, task.threadId, sendId)) {
          deps.deleteThread(botId, task.threadId);
          deps.botChanged(botId);
        }
        throw error;
      }
      return { threadId: task.threadId };
    },
    sendToThread: async ({ botId, threadId, text, callId, sendId }) => {
      if (deps.accepted(botId, threadId, sendId)) return;
      deps.assertBudget();
      await deps.send(botId, threadId, text, sendId, { kind: "voice_call", callId });
    },
    answerQuestion: async (item, answer) => {
      // the same card, still a plain question: a new ask that took its place
      // (or became an approval) needs its own read-out
      const live = deps.inbox().items.find((row) => row.id === item.id);
      if (!live?.requestId || live.requestId !== item.requestId || live.messageId !== item.messageId || isApproval(live)) return false;
      return deps.answer(live, answer);
    },
    postCard: (botId: string, card: VoiceCallCard, text: string) => {
      const task = callsThread(botId);
      if (!task) throw new Error("couldn't open the calls thread");
      const message: Omit<Message, "id" | "at"> = { role: "bot", kind: "text", text, voiceCall: card };
      const posted = store.appendMessage(task.threadId, message);
      // the calls thread's time is its newest call, not when it was opened
      store.patchTask(botId, task.threadId, { unread: true, lastActivityAt: posted.at });
      deps.botChanged(botId);
      return { threadId: task.threadId, messageId: posted.id };
    },
    patchCard: (_botId, threadId, messageId, card, text) => {
      store.patchMessage(threadId, messageId, { voiceCall: card, text });
    },
    readCard: (threadId, messageId) => store.messagesFor(threadId).find((message) => message.id === messageId)?.voiceCall ?? null,
  };
}
