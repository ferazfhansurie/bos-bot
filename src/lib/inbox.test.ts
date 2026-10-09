import { describe, expect, it, vi } from "vitest";

import { ApiError, initialState, reducer } from "@/state/store";
import {
  answerInboxItem,
  clearInbox,
  digestCountEntries,
  EMPTY_INBOX,
  fetchDigest,
  fetchInbox,
  groupInboxItems,
  inboxBadge,
  inboxItemAnswerable,
  inboxItemClearable,
  inboxKindLabel,
  inboxRelativeTime,
  normalizeDigest,
  normalizeInbox,
  type InboxItem,
} from "./inbox";

const item = (overrides: Partial<InboxItem> = {}): InboxItem => ({
  id: "i1", kind: "question", botId: "atlas", threadId: "t1", title: "Pick a plan", preview: "A or B?", at: 100,
  ...overrides,
});

describe("normalizeInbox", () => {
  it("drops malformed rows and keeps newest first", () => {
    const result = normalizeInbox({
      items: [
        item({ id: "old", at: 1 }),
        { id: "bad-kind", kind: "nope", threadId: "t", at: 5 },
        { kind: "failed", threadId: "t" },
        item({ id: "new", at: 9, groupId: "room" }),
      ],
      count: 2,
    });
    expect(result.items.map((row) => row.id)).toEqual(["new", "old"]);
    expect(result.items[0].groupId).toBe("room");
    expect(result.count).toBe(2);
  });

  it("reads a missing count from the rows and a junk body as empty", () => {
    expect(normalizeInbox({ items: [item()] }).count).toBe(1);
    expect(normalizeInbox({})).toEqual(EMPTY_INBOX);
    expect(normalizeInbox("<!doctype html>")).toEqual(EMPTY_INBOX);
  });
});

describe("normalizeInbox answer fields", () => {
  it("keeps card ids, live request ids and string options", () => {
    const [row] = normalizeInbox({ items: [item({ messageId: "m1", options: ["A", 3, "", "B"] as never })] }).items;
    expect(row).toMatchObject({ messageId: "m1", options: ["A", "B"] });
    expect(row).not.toHaveProperty("requestId");
    expect(inboxItemAnswerable(row)).toBe(true);
    expect(inboxItemClearable(row)).toBe(true);
  });

  it("an approval needs a request id and drops options", () => {
    const [live] = normalizeInbox({ items: [item({ kind: "waiting-on-you", messageId: "m1", requestId: "r1", approval: true, options: ["Allow"] })] }).items;
    expect(live).toMatchObject({ requestId: "r1", approval: true });
    expect(live).not.toHaveProperty("options");
    expect(inboxItemClearable(live)).toBe(false);
    const [bogus] = normalizeInbox({ items: [item({ approval: true })] }).items;
    expect(bogus).not.toHaveProperty("approval");
    expect(inboxItemAnswerable(bogus)).toBe(false);
  });

  it("an old server's rows read as plain open-only rows", () => {
    const [row] = normalizeInbox({ items: [item()] }).items;
    expect(row).not.toHaveProperty("options");
    expect(inboxItemAnswerable(row)).toBe(false);
  });
});

describe("clear and answer", () => {
  it("clears all with an empty body, named rows with ids, and tolerates an old server", async () => {
    const request = vi.fn(async (_path: string, _init?: RequestInit) => ({ cleared: 2, kept: 1 }));
    await expect(clearInbox(undefined, request)).resolves.toEqual({ cleared: 2, kept: 1 });
    expect(request).toHaveBeenLastCalledWith("/api/inbox/clear", { method: "POST", body: "{}" });
    await clearInbox(["unread:t1"], request);
    expect(request).toHaveBeenLastCalledWith("/api/inbox/clear", { method: "POST", body: JSON.stringify({ ids: ["unread:t1"] }) });
    await expect(clearInbox(undefined, async () => { throw new ApiError("404 Not Found", 404); })).resolves.toBeNull();
    await expect(clearInbox(undefined, async () => { throw new ApiError("boom", 500); })).rejects.toThrow("boom");
  });

  it("answers live asks by thread, the way the in-chat cards do", async () => {
    const request = vi.fn(async (_path: string, _init?: RequestInit) => ({}));
    await answerInboxItem(item({ kind: "waiting-on-you", requestId: "r1", approval: true }), { behavior: "deny" }, request);
    expect(request).toHaveBeenLastCalledWith("/api/threads/t1/respond", { method: "POST", body: JSON.stringify({ requestId: "r1", behavior: "deny", message: "Denied by the user." }) });
    await answerInboxItem(item({ kind: "waiting-on-you", requestId: "r1", approval: true }), { behavior: "allow" }, request);
    expect(JSON.parse(String(request.mock.lastCall?.[1]?.body))).toEqual({ requestId: "r1", behavior: "allow" });
    await answerInboxItem(item({ kind: "waiting-on-you", requestId: "r2", options: ["Ship"] }), { option: "Ship" }, request);
    expect(JSON.parse(String(request.mock.lastCall?.[1]?.body))).toEqual({ requestId: "r2", behavior: "answer", message: "Ship" });
  });

  it("answers a plain card by settling it, then sending the choice", async () => {
    const request = vi.fn(async (_path: string, _init?: RequestInit) => ({}));
    await answerInboxItem(item({ messageId: "m1", options: ["A"] }), { option: "A" }, request);
    expect(request.mock.calls.map(([path]) => path)).toEqual(["/api/bots/atlas/cards/m1", "/api/bots/atlas/messages"]);
    expect(JSON.parse(String(request.mock.calls[0][1]?.body))).toEqual({ answered: "A", dismissed: true, threadId: "t1" });
    expect(JSON.parse(String(request.mock.calls[1][1]?.body))).toEqual({ text: "A", threadId: "t1" });
    await expect(answerInboxItem(item({ messageId: "m1", groupId: "room" }), { option: "A" }, request)).rejects.toThrow();
  });
});

describe("normalizeDigest", () => {
  it("clamps counts and filters moves", () => {
    const digest = normalizeDigest({
      since: 1, until: 2,
      counts: { done: 3, started: -1, closed: 1.7, failed: "x", waiting: 2 },
      moved: [
        { botId: "atlas", threadId: "t1", title: "A", change: "done", summary: "shipped", at: 1 },
        { botId: "atlas", threadId: "t2", title: "B", change: "teleported", summary: "", at: 2 },
        { botId: "atlas", threadId: "t3", title: "C", change: "failed", summary: "", at: 3, groupId: "room" },
      ],
    });
    expect(digest?.counts).toEqual({ done: 3, started: 0, closed: 1, failed: 0, waiting: 2 });
    expect(digest?.moved.map((move) => move.threadId)).toEqual(["t3", "t1"]);
    expect(digest?.moved[0].groupId).toBe("room");
  });

  it("is null for a body that is not a digest", () => {
    expect(normalizeDigest({})).toBeNull();
    expect(normalizeDigest(null)).toBeNull();
  });
});

describe("fetch fallbacks", () => {
  it("reads a server without /api/inbox as nothing waiting", async () => {
    const request = vi.fn(async () => { throw new ApiError("404 Not Found", 404); });
    await expect(fetchInbox(request)).resolves.toEqual(EMPTY_INBOX);
    expect(request).toHaveBeenCalledWith("/api/inbox");
  });

  it("reads the SPA fallback (200, no json) as nothing waiting", async () => {
    await expect(fetchInbox(async () => ({}))).resolves.toEqual(EMPTY_INBOX);
  });

  it("still surfaces real failures", async () => {
    await expect(fetchInbox(async () => { throw new ApiError("boom", 500); })).rejects.toThrow("boom");
  });

  it("asks for the digest window and tolerates a 404", async () => {
    const request = vi.fn(async () => { throw new ApiError("404 Not Found", 404); });
    await expect(fetchDigest(1234.9, request)).resolves.toBeNull();
    expect(request).toHaveBeenCalledWith("/api/digest?since=1234");
    const plain = vi.fn(async () => ({ counts: {} }));
    await fetchDigest(undefined, plain);
    expect(plain).toHaveBeenCalledWith("/api/digest");
  });
});

describe("grouping and labels", () => {
  it("orders kinds by urgency and keeps server order inside a kind", () => {
    const groups = groupInboxItems([
      item({ id: "u", kind: "unread" }),
      item({ id: "q1", kind: "question" }),
      item({ id: "f", kind: "failed" }),
      item({ id: "w", kind: "waiting-on-you" }),
      item({ id: "q2", kind: "question" }),
    ]);
    expect(groups.map((group) => group.kind)).toEqual(["waiting-on-you", "question", "failed", "unread"]);
    expect(groups[1].items.map((row) => row.id)).toEqual(["q1", "q2"]);
    expect(groupInboxItems([])).toEqual([]);
  });

  it("hides the badge at zero and caps it", () => {
    expect(inboxBadge(0)).toBe("");
    expect(inboxBadge(3)).toBe("3");
    expect(inboxBadge(120)).toBe("99+");
  });

  it("labels kinds, counts and times through the catalog", () => {
    expect(inboxKindLabel("waiting-on-you")).toBe("Waiting on you");
    expect(digestCountEntries({ done: 1, started: 2, closed: 3, failed: 4, waiting: 5 }).map((entry) => `${entry.value} ${entry.label}`))
      .toEqual(["1 done", "2 started", "3 closed", "4 failed", "5 waiting"]);
    const now = 10_000_000;
    expect(inboxRelativeTime(now - 30_000, now)).toBe("just now");
    expect(inboxRelativeTime(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(inboxRelativeTime(now - 3 * 3_600_000, now)).toBe("3 h ago");
  });
});

describe("inbox state", () => {
  it("keeps a clean count and leaves state alone when it is unchanged", () => {
    const next = reducer(initialState, { type: "inboxCount", count: 4 });
    expect(next.inboxCount).toBe(4);
    expect(reducer(next, { type: "inboxCount", count: 4 })).toBe(next);
    expect(reducer(next, { type: "inboxCount", count: -2 }).inboxCount).toBe(0);
  });

  it("opens needs me as the jobs page over any open panel", () => {
    const next = reducer({ ...initialState, settingsOpen: true, pluginsOpen: true }, { type: "showNeedsMe" });
    expect(next.activeView).toBe("jobs");
    expect(next.settingsOpen).toBe(false);
    expect(next.pluginsOpen).toBe(false);
  });
});

it("preserves persistent lead report metadata and keeps it non-clearable", () => {
  const leadAction = { id: "report", leadBotId: "bos", kind: "blocker" as const, status: "blocked" as const, requiredAction: "fix fixture", updatedAt: 20 };
  const normalized = normalizeInbox({ items: [item({ kind: "waiting-on-you", leadAction })] });
  expect(normalized.items[0].leadAction).toEqual(leadAction);
  expect(inboxItemClearable(normalized.items[0])).toBe(false);
});
