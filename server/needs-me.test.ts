import { describe, expect, it } from "vitest";
import { buildDigest, buildInbox, digestDue, digestNotificationBody, failedTurn, inboxItemFor, localDateKey, type NeedsMeMessage, type NeedsMeThread } from "./needs-me.ts";

const now = 1_800_000_000_000;
let seq = 0;
const msg = (over: Partial<NeedsMeMessage>): NeedsMeMessage => ({ id: `m${seq++}`, at: now, role: "bot", kind: "text", ...over });
const thread = (over: Partial<NeedsMeThread> = {}): NeedsMeThread => ({
  botId: "bot_a", threadId: "t1", title: "Brief", createdAt: now - 10_000, lastActivityAt: now - 5_000,
  archived: false, unread: false, waiting: false, working: false, messages: [], ...over,
});
const failure = (at: number) => msg({ at, text: "partial", turnTerminal: true, turnOutcome: { ok: false, stopReason: "provider crashed" } });
const success = (at: number, text = "Shipped it") => msg({ at, text, turnTerminal: true, turnOutcome: { ok: true } });
const card = (at: number, extra: Partial<NonNullable<NeedsMeMessage["card"]>> = {}) => msg({ at, kind: "card", card: { title: "Pick one", subtitle: "A or B", ...extra } });

describe("inbox", () => {
  it("a quiet thread needs nothing", () => expect(inboxItemFor(thread())).toBeNull());

  it("waiting-on-you beats an open card, which beats a failure, which beats unread", () => {
    const messages = [failure(now - 300), card(now - 200)];
    expect(inboxItemFor(thread({ waiting: true, unread: true, messages }))).toMatchObject({ id: "waiting-on-you:t1", kind: "waiting-on-you", preview: "Pick one — A or B", at: now - 200 });
    expect(inboxItemFor(thread({ unread: true, messages }))).toMatchObject({ id: "question:t1", kind: "question", at: now - 200 });
    expect(inboxItemFor(thread({ unread: true, messages: [failure(now - 300)] }))).toMatchObject({ kind: "failed", preview: "provider crashed", at: now - 300 });
    expect(inboxItemFor(thread({ unread: true, messages: [success(now - 100, "All green")] }))).toMatchObject({ kind: "unread", preview: "All green", at: now - 100 });
  });

  it("waiting with no card falls back to the thread's activity time", () => {
    expect(inboxItemFor(thread({ waiting: true }))).toMatchObject({ kind: "waiting-on-you", preview: "Waiting on you", at: now - 5_000 });
  });

  it("answered and dismissed cards are not questions", () => {
    expect(inboxItemFor(thread({ messages: [card(now, { answered: "A" })] }))).toBeNull();
    expect(inboxItemFor(thread({ messages: [card(now, { dismissed: true })] }))).toBeNull();
  });

  it("an old failure is not news while a turn runs, after the person replied, or after a later success", () => {
    expect(inboxItemFor(thread({ working: true, messages: [failure(now)] }))).toBeNull();
    expect(failedTurn([failure(now - 2), msg({ at: now - 1, role: "user", text: "try again" })])).toBeUndefined();
    expect(failedTurn([failure(now - 2), success(now - 1)])).toBeUndefined();
  });

  it("closed and archived threads are never in the inbox", () => {
    const closedBy = { botId: "", name: "Inbox", at: now };
    expect(inboxItemFor(thread({ waiting: true, closedBy }))).toBeNull();
    expect(inboxItemFor(thread({ unread: true, archived: true }))).toBeNull();
  });

  it("carries groupId for room rows only and sorts newest first", () => {
    const inbox = buildInbox([
      thread({ threadId: "old", unread: true, lastActivityAt: now - 9_000 }),
      thread({ threadId: "room", groupId: "grp_1", unread: true, lastActivityAt: now - 1_000 }),
      thread({ threadId: "none" }),
    ]);
    expect(inbox.count).toBe(2);
    expect(inbox.items.map(item => item.threadId)).toEqual(["room", "old"]);
    expect(inbox.items[0]).toMatchObject({ groupId: "grp_1", botId: "bot_a", title: "Brief" });
    expect(inbox.items[1]).not.toHaveProperty("groupId");
  });
});

describe("digest", () => {
  const since = now - 86_400_000;
  it("counts started, done, failed and closed inside the window, newest first", () => {
    const digest = buildDigest([
      thread({ threadId: "new", createdAt: now - 1_000, messages: [msg({ at: now - 900, role: "user", text: "Draft the launch post" }), success(now - 500, "Posted the draft")] }),
      thread({ threadId: "broke", createdAt: since - 1, messages: [failure(now - 700)] }),
      thread({ threadId: "shut", createdAt: since - 1, closedBy: { botId: "bot_b", name: "Parker", at: now - 100 } }),
      thread({ threadId: "stale", createdAt: since - 5, messages: [success(since - 2)] }),
    ], since, now, 3);
    expect(digest).toMatchObject({ since, until: now, counts: { done: 1, started: 1, closed: 1, failed: 1, waiting: 3 } });
    expect(digest.moved.map(move => [move.threadId, move.change, move.summary])).toEqual([
      ["shut", "closed", "Closed by Parker"],
      ["new", "done", "Posted the draft"],
      ["broke", "failed", "provider crashed"],
      ["new", "started", "Draft the launch post"],
    ]);
  });

  it("the newest settled turn in the window decides done or failed", () => {
    const digest = buildDigest([thread({ createdAt: since - 1, messages: [failure(now - 500), success(now - 100)] })], since, now, 0);
    expect(digest.counts).toMatchObject({ done: 1, failed: 0 });
  });

  it("writes one lock-screen line", () => {
    const quiet = buildDigest([], since, now, 0);
    expect(digestNotificationBody(quiet)).toBe("Quiet day · nothing waiting on you");
    expect(digestNotificationBody({ ...quiet, counts: { done: 2, started: 1, closed: 0, failed: 1, waiting: 4 } })).toBe("2 done, 1 started, 1 failed · 4 waiting on you");
  });

  it("is due once per local day, at or after the hour", () => {
    const morning = new Date(2026, 9, 5, 9, 0);
    expect(localDateKey(morning)).toBe("2026-10-05");
    expect(digestDue(new Date(2026, 9, 5, 8, 59), 9, null)).toBe(false);
    expect(digestDue(morning, 9, null)).toBe(true);
    expect(digestDue(morning, 9, "2026-10-04")).toBe(true);
    expect(digestDue(new Date(2026, 9, 5, 23, 0), 9, "2026-10-05")).toBe(false);
  });
});
