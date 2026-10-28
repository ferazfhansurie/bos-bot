// 3.0 needs-you: the sidebar chip and filter over what is actually the
// person's to do. Same rule as the jobs page's "your move": live approvals,
// questions and connect cards, plus jobs stuck on the person. A bot that is
// only working is not here; that is what made "needs you · 1" show on a
// plain running turn.
import { useEffect, useState } from "react";
import { fetchInbox, type InboxItem } from "./inbox";
import { fetchJobInbox, type JobInboxItem } from "./job-inbox";
import { isYourMoveAsk } from "./jobs-page";

export interface NeedsYou {
  count: number;
  botIds: ReadonlySet<string>;
  groupIds: ReadonlySet<string>;
  /** connect cards for an app that signed out; the fix-it cards read these */
  reconnects: readonly InboxItem[];
  /** false until the first fetch lands */
  loaded: boolean;
}

export const NO_NEEDS_YOU: NeedsYou = { count: 0, botIds: new Set(), groupIds: new Set(), reconnects: [], loaded: false };

/** Who owns each thing on the person: room rows go to the room, the rest to
 * the bot. A job's thread that belongs to a room goes to that room. */
export function needsYouOwners(
  asks: readonly InboxItem[],
  jobs: readonly JobInboxItem[],
  roomOfThread: (threadId: string) => string | undefined = () => undefined,
): NeedsYou {
  const botIds = new Set<string>();
  const groupIds = new Set<string>();
  const mine = asks.filter(isYourMoveAsk);
  for (const item of mine) {
    if (item.groupId) groupIds.add(item.groupId);
    else if (item.botId) botIds.add(item.botId);
  }
  const stuck = jobs.filter((job) => job.state === "needs-you" || job.state === "blocked");
  for (const job of stuck) {
    const room = roomOfThread(job.threadId);
    if (room) groupIds.add(room);
    else if (job.botId) botIds.add(job.botId);
  }
  return { count: mine.length + stuck.length, botIds, groupIds, reconnects: mine.filter((item) => item.connect?.reconnect), loaded: true };
}

/** Bots on the person's linked servers ask through their own server, which
 * the local inbox never sees; their roster activity is the only signal, so a
 * linked bot waiting on the person counts once on top of the local set. */
export function withLinkedWaiting(value: NeedsYou, bots: ReadonlyArray<{ id: string; activity?: string; homeLink?: unknown }>): NeedsYou {
  const linked = bots.filter((bot) => bot.homeLink && bot.activity === "waiting-on-you" && !value.botIds.has(bot.id));
  if (!linked.length) return value;
  return { ...value, count: value.count + linked.length, botIds: new Set([...value.botIds, ...linked.map((bot) => bot.id)]) };
}

const RECHECK_MS = 30_000;

/** The live needs-you set, refetched whenever `refreshKey` moves, on window
 * focus and every 30 seconds: a card answered or dismissed in place moves no
 * key. Off (no request at all) when `enabled` is false, so the flag-off app
 * is unchanged. */
export function useNeedsYou(enabled: boolean, refreshKey: string, roomOfThread?: (threadId: string) => string | undefined): NeedsYou {
  const [value, setValue] = useState<NeedsYou>(NO_NEEDS_YOU);
  useEffect(() => {
    if (!enabled) { setValue(NO_NEEDS_YOU); return; }
    let alive = true;
    const load = () => Promise.all([fetchInbox(), fetchJobInbox().catch(() => null)]).then(([inbox, jobs]) => {
      if (alive) setValue(needsYouOwners(inbox.items, jobs?.items ?? [], roomOfThread));
    }, () => {});
    void load();
    const timer = setInterval(() => { void load(); }, RECHECK_MS);
    window.addEventListener("focus", load);
    return () => { alive = false; clearInterval(timer); window.removeEventListener("focus", load); };
    // roomOfThread reads the same state the key is built from
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, refreshKey]);
  return value;
}
