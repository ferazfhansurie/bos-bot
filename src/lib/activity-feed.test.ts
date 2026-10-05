import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  applyActivityFrame, botActivityState, createActivityFeed, gestureForActivity, loadActivityFeed, parseActivityEntry, withLiveActivity,
} from "./activity-feed";
import { SidebarActivityAvatar } from "@/components/SidebarActivityAvatar";
import type { Bot } from "@/state/store";

const entry = (threadId: string, state: string, since = 1, botId = "scout") => ({ botId, threadId, roomId: null, state, since });

describe("activity feed", () => {
  it("drops malformed and unknown states instead of animating on them", () => {
    expect(parseActivityEntry({ botId: "a", threadId: "t", state: "dancing", since: 1 })).toBeNull();
    expect(parseActivityEntry({ threadId: "t", state: "tool", since: 1 })).toBeNull();
    expect(parseActivityEntry(entry("t", "waiting-on-person"))?.state).toBe("waiting");
    expect(parseActivityEntry({ ...entry("t", "tool"), since: "2026-10-06T00:00:00Z" })?.since).toBe(Date.parse("2026-10-06T00:00:00Z"));
  });

  it("applies live frames per (bot, thread) and never rolls back to an older frame", () => {
    const feed = createActivityFeed();
    let renders = 0;
    feed.subscribe(() => { renders += 1; });
    expect(applyActivityFrame({ kind: "activity", ...entry("t1", "thinking", 10) }, feed)).toBe(true);
    applyActivityFrame({ kind: "activity", activity: entry("t1", "tool", 20) }, feed);
    applyActivityFrame({ kind: "activity", ...entry("t1", "thinking", 15) }, feed);
    applyActivityFrame({ kind: "activity", ...entry("t1", "tool", 20) }, feed);
    expect(feed.get("scout", "t1")?.state).toBe("tool");
    expect(renders).toBe(2);
    expect(applyActivityFrame({ kind: "bot" }, feed)).toBe(false);
  });

  it("replaces everything from the snapshot and fails closed when it can't load", async () => {
    const feed = createActivityFeed();
    feed.apply(entry("stale", "tool"));
    await loadActivityFeed(async () => ({ items: [entry("t2", "typing")] }), feed);
    expect(feed.get("scout", "stale")).toBeUndefined();
    expect(feed.get("scout", "t2")?.state).toBe("typing");
    await loadActivityFeed(async () => { throw new Error("403"); }, feed);
    expect(feed.get("scout", "t2")?.state).toBe("typing");
  });

  it("picks the one state a bot row shows: waiting, then visible work, then rest", () => {
    expect(botActivityState([entry("a", "thinking"), entry("b", "tool")] as never, [])).toBe("tool");
    expect(botActivityState([entry("a", "tool")] as never, [{ threadId: "c", activity: "waiting-on-you" }])).toBe("waiting");
    expect(botActivityState([entry("a", "failed")] as never, [])).toBe("failed");
    // a feed entry wins over the harness flag for its own thread
    expect(botActivityState([entry("a", "idle")] as never, [{ threadId: "a", busy: true }])).toBe("idle");
    expect(botActivityState([], [{ threadId: "a", busy: true }])).toBe("thinking");
    expect(gestureForActivity("tool")).toBe("working");
    expect(gestureForActivity("stopped")).toBe("idle");
  });

  it("marks a thread the feed says is moving as working in sidebar lists, never hides one", () => {
    const feed = createActivityFeed();
    feed.apply(entry("t1", "typing"));
    feed.apply(entry("t2", "waiting"));
    feed.apply(entry("t3", "idle"));
    expect(withLiveActivity("scout", { threadId: "t1" }, feed)).toMatchObject({ busy: true, activity: "working" });
    expect(withLiveActivity("scout", { threadId: "t2" }, feed)).toMatchObject({ activity: "waiting-on-you" });
    expect(withLiveActivity("scout", { threadId: "t3", busy: true }, feed)).toMatchObject({ busy: true });
    expect(withLiveActivity("other", { threadId: "t1" }, feed).busy).toBeUndefined();
  });
});

describe("SidebarActivityAvatar", () => {
  const bot = { id: "scout", name: "scout", color: "green", mascotBody: "star" } as unknown as Bot;
  it("keeps the still avatar at rest and runs the mascot gesture while working", () => {
    const rest = renderToStaticMarkup(createElement(SidebarActivityAvatar, { bot, gesture: "idle", size: 32 }, createElement("i", null, "still")));
    expect(rest).toBe("<i>still</i>");
    const busy = renderToStaticMarkup(createElement(SidebarActivityAvatar, { bot, gesture: "working", size: 32 }, createElement("i", null, "still")));
    expect(busy).toContain('data-sidebar-activity-mascot="working"');
    expect(busy).toContain('data-gesture="working"');
    expect(busy).not.toContain("still");
  });
});
