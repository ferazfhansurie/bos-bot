// The main window's half of the notch (electron/notch.mjs): it turns what
// this window already holds into a snapshot for the notch page, and carries
// out what the person did there through the same calls the app's own
// buttons make. It renders nothing.
import { useEffect, useMemo, useRef, useState } from "react";
import { useActivityFeed, type ActivityEntry, type ActivityState } from "@/lib/activity-feed";
import { useAttentionPreferences } from "@/lib/attention-preferences";
import { fileAttachment } from "@/lib/composer-attachments";
import { appendDraftAttachments } from "@/lib/drafts";
import { answerInboxItem, fetchInbox, type InboxItem } from "@/lib/inbox";
import { openNotificationTarget, useStore, visibleNotificationThread } from "@/state/store";
import { setNotchActive } from "./active";
import { MOMENT_MS, askKey, buildNotchSnapshot, momentFor, threadTitle } from "./feed";
import type { NotchAction, NotchDrop, NotchMoment } from "./types";

const SEND_EVERY_MS = 250;

export function NotchFeed() {
  const bridge = typeof window !== "undefined" && window.ogb?.platform === "darwin" ? window.ogb.notch : undefined;
  if (!bridge) return null;
  return <Feed bridge={bridge} />;
}

function Feed({ bridge }: { bridge: NonNullable<NonNullable<Window["ogb"]>["notch"]> }) {
  const { state, dispatch } = useStore();
  const prefs = useAttentionPreferences();
  const activity = useActivityFeed();
  const on = prefs.notch;
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    bridge.enable(on);
    setNotchActive(on);
    return () => setNotchActive(false);
  }, [bridge, on]);
  useEffect(() => () => bridge.enable(false), [bridge]);

  // the thread on screen in a focused window stays off the notch
  const [focused, setFocused] = useState(() => document.hasFocus());
  useEffect(() => {
    const update = () => setFocused(document.hasFocus());
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);
  const hiddenThreadId = focused ? visibleNotificationThread(state) : null;

  // done and failed are moments: a live thread that came to rest
  const [moments, setMoments] = useState<NotchMoment[]>([]);
  const previous = useRef(new Map<string, ActivityState>());
  const [waitingBump, setWaitingBump] = useState(0);
  useEffect(() => {
    if (!on) return;
    const seen = previous.current;
    const fresh: NotchMoment[] = [];
    let newlyWaiting = false;
    for (const [key, entry] of activity) {
      const before = seen.get(key);
      if (entry.state === "waiting" && before !== "waiting") newlyWaiting = true;
      const kind = momentFor(before, entry, routineThread(entry, stateRef.current.bots));
      if (kind) {
        fresh.push({
          id: `${entry.botId}:${entry.threadId}:${entry.since}`,
          kind,
          botId: entry.botId,
          threadId: entry.threadId,
          title: threadTitle(entry.threadId, stateRef.current.bots, stateRef.current.groups),
          at: Date.now(),
        });
      }
    }
    previous.current = new Map([...activity].map(([key, entry]) => [key, entry.state]));
    if (fresh.length) setMoments((current) => [...current.filter((moment) => !fresh.some((next) => next.id === moment.id)), ...fresh]);
    if (newlyWaiting) setWaitingBump((value) => value + 1);
  }, [activity, on]);
  useEffect(() => {
    if (!moments.length) return;
    const next = Math.min(...moments.map((moment) => moment.at)) + MOMENT_MS - Date.now();
    const timer = window.setTimeout(() => {
      const cutoff = Date.now() - MOMENT_MS;
      setMoments((current) => current.filter((moment) => moment.at > cutoff));
    }, Math.max(50, next));
    return () => window.clearTimeout(timer);
  }, [moments]);

  // the inbox holds the asks; a frame bumps its count, a bot starting to
  // wait may land a moment before that
  const [inbox, setInbox] = useState<InboxItem[]>([]);
  const inboxRef = useRef(inbox);
  inboxRef.current = inbox;
  const [inboxBump, setInboxBump] = useState(0);
  useEffect(() => {
    if (!on) return;
    let alive = true;
    const timer = window.setTimeout(() => {
      fetchInbox().then((response) => alive && setInbox(response.items), () => {});
    }, inboxBump || waitingBump ? 150 : 0);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [on, state.inboxCount, waitingBump, inboxBump]);
  // a slow safety net: a missed frame must not leave an ask stuck up there
  useEffect(() => {
    if (!on || !inbox.length) return;
    const timer = window.setInterval(() => setInboxBump((value) => value + 1), 30_000);
    return () => window.clearInterval(timer);
  }, [on, inbox.length]);

  const snapshot = useMemo(
    () => buildNotchSnapshot({ bots: state.bots, groups: state.groups, activity, inbox, hiddenThreadId, moments, prefs }),
    [state.bots, state.groups, activity, inbox, hiddenThreadId, moments, prefs],
  );

  // send only what changed, and at most a few times a second
  const sent = useRef("");
  const pending = useRef<string | null>(null);
  const timer = useRef<number | null>(null);
  useEffect(() => {
    if (!on) {
      sent.current = "";
      return;
    }
    const json = JSON.stringify(snapshot);
    if (json === sent.current) return;
    pending.current = json;
    if (timer.current !== null) return;
    const flush = () => {
      timer.current = null;
      if (pending.current === null || pending.current === sent.current) return;
      sent.current = pending.current;
      pending.current = null;
      bridge.update(JSON.parse(sent.current));
      timer.current = window.setTimeout(flush, SEND_EVERY_MS);
    };
    flush();
  }, [bridge, on, snapshot]);
  // a remount starts clean: a stale timer id would hold every later send
  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    pending.current = null;
    sent.current = "";
  }, []);

  useEffect(() => bridge.onAction((action: NotchAction | NotchDrop) => {
    const current = stateRef.current;
    const open = (botId: string, threadId: string) => {
      openNotificationTarget(dispatch, { botId, threadId }, current);
      dispatch({ type: "revealThread", threadId });
    };
    if (action.type === "open") return open(action.botId, action.threadId);
    if (action.type === "ask") {
      // the same path as a reply typed into a banner: into the thread the
      // bot is on, and the app stays where the person left it
      const group = current.groups.find((candidate) =>
        candidate.threadId === action.threadId || (candidate.tasks ?? []).some((task) => task.threadId === action.threadId));
      if (group) return dispatch({ type: "sendGroup", groupId: group.id, threadId: action.threadId, text: action.text });
      if (!current.bots.some((bot) => bot.id === action.botId)) return;
      dispatch({ type: "send", botId: action.botId, threadId: action.threadId, text: action.text });
      return;
    }
    if (action.type === "drop") {
      const draft = dropDraft(current, action.botId, action.threadId);
      open(action.botId, action.threadId);
      // a remote bot's files would have to cross machines; open it, attach nothing
      if (!draft || !action.files.length) return;
      appendDraftAttachments(draft, action.files.map((file) => fileAttachment(file.name, file.path, file.size)));
      return;
    }
    const refetch = () => window.setTimeout(() => setInboxBump((value) => value + 1), 400);
    // the exact request the person saw: a conversation's next ask reuses
    // its row id, and must never take an answer meant for the one before
    const item = inboxRef.current.find((candidate) => askKey(candidate) === action.askId);
    if (!item) {
      refetch();
      return;
    }
    // gone from the notch at once; the next fetch has the truth
    setInbox((items) => items.filter((candidate) => candidate !== item));
    const { answer } = action;
    if (item.requestId) {
      const behavior = "behavior" in answer ? answer.behavior : "answer";
      const message = "text" in answer ? answer.text : "option" in answer ? answer.option : undefined;
      dispatch({ type: "decideRequest", threadId: item.threadId, requestId: item.requestId, behavior, ...(message ? { message } : {}) });
      refetch();
      return;
    }
    if ("option" in answer) {
      answerInboxItem(item, { option: answer.option }).then(refetch, () => {
        refetch();
        open(item.botId, item.threadId);
      });
    }
  }), [bridge, dispatch]);

  return null;
}

/** Where files dropped on a bot's row belong: the composer draft of the
 * thread the row opens, keyed the way the composer keys it (a room thread
 * under its room). Null when that thread is not this bot's or its room's,
 * or the bot is remote. */
function dropDraft(state: ReturnType<typeof useStore>["state"], botId: string, threadId: string): string | null {
  const bot = state.bots.find((candidate) => candidate.id === botId);
  if (!bot || bot.remote) return null;
  const group = state.groups.find((candidate) =>
    candidate.memberIds.includes(bot.id) && (candidate.threadId === threadId || candidate.tasks?.some((task) => task.threadId === threadId)));
  if (group) return `group:${group.id}:${threadId}`;
  return bot.threadId === threadId || bot.tasks?.some((task) => task.threadId === threadId) ? `bot:${bot.id}:${threadId}` : null;
}

/** a routine's run thread: its quiet success is not news */
function routineThread(entry: ActivityEntry, bots: ReturnType<typeof useStore>["state"]["bots"]): boolean {
  return Boolean(bots.find((bot) => bot.id === entry.botId)?.tasks?.find((task) => task.threadId === entry.threadId)?.routineRunId);
}
