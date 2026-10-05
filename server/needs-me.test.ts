import { describe, expect, it } from "vitest";
import { buildDigest, buildInbox, digestDue, digestNotificationBody, failedTurn, inboxItemClearable, inboxItemFor, localDateKey, partitionInboxClear, type NeedsMeMessage, type NeedsMeThread } from "./needs-me.ts";

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

describe("inbox clear and inline answers", () => {
  it("an acknowledged failure stops showing until a newer one", () => {
    const failed = failure(now - 300);
    expect(inboxItemFor(thread({ messages: [failed], failureAckedAt: now - 300 }))).toBeNull();
    // the ack only covers the failure; an unread reply under it still shows
    expect(inboxItemFor(thread({ unread: true, messages: [failed], failureAckedAt: now - 200 }))).toMatchObject({ kind: "unread" });
    expect(inboxItemFor(thread({ messages: [failed], failureAckedAt: now - 301 }))).toMatchObject({ kind: "failed" });
    expect(inboxItemFor(thread({ messages: [failed, failure(now - 100)], failureAckedAt: now - 200 }))).toMatchObject({ kind: "failed", at: now - 100 });
  });

  it("a plain question carries its choices and card id", () => {
    const open = card(now, { options: ["A", "B", { label: "C" } as unknown as string, "A"] });
    expect(inboxItemFor(thread({ messages: [open] }))).toMatchObject({ kind: "question", messageId: open.id, options: ["A", "B", "C"] });
    expect(inboxItemFor(thread({ messages: [open] }))).not.toHaveProperty("requestId");
    // a room's plain card has no answer path outside the room
    expect(inboxItemFor(thread({ groupId: "grp_1", messages: [open] }))).not.toHaveProperty("options");
  });

  it("a live approval is allow/deny, a live question offers its options, proposals offer nothing", () => {
    const approval = card(now, { requestId: "req_1", tool: "Bash", options: ["Allow", "Deny"] });
    expect(inboxItemFor(thread({ waiting: true, messages: [approval] }))).toMatchObject({ kind: "waiting-on-you", requestId: "req_1", messageId: approval.id, approval: true });
    expect(inboxItemFor(thread({ waiting: true, messages: [approval] }))).not.toHaveProperty("options");
    const ask = card(now, { requestId: "req_2", options: ["Ship", "Hold"] });
    expect(inboxItemFor(thread({ waiting: true, groupId: "grp_1", messages: [ask] }))).toMatchObject({ requestId: "req_2", options: ["Ship", "Hold"] });
    const routine = card(now, { requestId: "req_3", options: ["Confirm"], routineRequest: {} as never });
    const item = inboxItemFor(thread({ waiting: true, messages: [routine] }))!;
    expect(item).toMatchObject({ requestId: "req_3" });
    expect(item).not.toHaveProperty("options");
    expect(item).not.toHaveProperty("approval");
  });

  it("a waiting row does not offer an older plain card's options", () => {
    const item = inboxItemFor(thread({ waiting: true, messages: [card(now, { options: ["A"] })] }))!;
    expect(item.kind).toBe("waiting-on-you");
    expect(item).not.toHaveProperty("options");
    expect(item).not.toHaveProperty("messageId");
  });

  it("clears everything but live asks, and only the rows it names", () => {
    const inbox = buildInbox([
      thread({ threadId: "wait", waiting: true, messages: [card(now - 1, { requestId: "req_1", tool: "Bash" })] }),
      thread({ threadId: "live-q", messages: [card(now - 2, { requestId: "req_2" })] }),
      thread({ threadId: "q", messages: [card(now - 3)] }),
      thread({ threadId: "f", messages: [failure(now - 4)] }),
      thread({ threadId: "u", unread: true }),
    ]);
    expect(inbox.items.filter(inboxItemClearable).map(item => item.threadId)).toEqual(["q", "f", "u"]);
    const all = partitionInboxClear(inbox.items);
    expect(all.clear.map(item => item.id)).toEqual(["question:q", "failed:f", "unread:u"]);
    expect(all.kept.map(item => item.id)).toEqual(["waiting-on-you:wait", "question:live-q"]);
    const named = partitionInboxClear(inbox.items, ["failed:f", "waiting-on-you:wait", "unread:not-visible"]);
    expect(named.clear.map(item => item.id)).toEqual(["failed:f"]);
    expect(named.kept.map(item => item.id)).toEqual(["waiting-on-you:wait"]);
    expect(partitionInboxClear(inbox.items, [])).toEqual({ clear: [], kept: [] });
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
