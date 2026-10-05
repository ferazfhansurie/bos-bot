import { describe, expect, it, vi } from "vitest";

import { ApiError, initialState, reducer } from "@/state/store";
import {
  digestCountEntries,
  EMPTY_INBOX,
  fetchDigest,
  fetchInbox,
  groupInboxItems,
  inboxBadge,
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

  it("opens the needs-me view over any open panel", () => {
    const next = reducer({ ...initialState, settingsOpen: true, pluginsOpen: true }, { type: "showNeedsMe" });
    expect(next.activeView).toBe("needs-me");
    expect(next.settingsOpen).toBe(false);
    expect(next.pluginsOpen).toBe(false);
  });
});
