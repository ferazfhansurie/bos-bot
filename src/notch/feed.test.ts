import { describe, expect, it } from "vitest";
import type { ActivityEntry } from "@/lib/activity-feed";
import type { InboxItem } from "@/lib/inbox";
import { askKey, buildNotchSnapshot, momentFor, notchAsk, type NotchInputs } from "./feed";

const prefs = { approval: true, question: true, sound: "default" as const };
const key = (botId: string, threadId: string) => `${botId}\u0000${threadId}`;

function bot(id: string, extra: Partial<NotchInputs["bots"][number]> = {}): NotchInputs["bots"][number] {
  return { id, name: id, color: "green", mascotBody: null, threadId: `${id}-main`, tasks: [], hidden: false, busy: false, activity: undefined, ...extra } as NotchInputs["bots"][number];
}

function inputs(extra: Partial<NotchInputs> = {}): NotchInputs {
  return { bots: [], groups: [], activity: new Map(), inbox: [], hiddenThreadId: null, moments: [], prefs, ...extra };
}

function entry(botId: string, threadId: string, state: ActivityEntry["state"], since = 1): ActivityEntry {
  return { botId, threadId, state, since };
}

const ask = (extra: Partial<InboxItem>): InboxItem => ({
  id: "i1", kind: "waiting-on-you", botId: "a", threadId: "t1", title: "deploy", preview: "run   pnpm build", at: 5, ...extra,
});

describe("buildNotchSnapshot", () => {
  it("puts the waiting bot first, then the longest-running", () => {
    const activity = new Map([
      [key("a", "t1"), entry("a", "t1", "thinking", 10)],
      [key("b", "t2"), entry("b", "t2", "waiting", 50)],
      [key("c", "t3"), entry("c", "t3", "tool", 5)],
    ]);
    const snap = buildNotchSnapshot(inputs({ bots: [bot("a"), bot("b"), bot("c")], activity }));
    expect(snap.working.map((row) => row.id)).toEqual(["b", "c", "a"]);
  });

  it("shows one row per bot, its most urgent thread", () => {
    const activity = new Map([
      [key("a", "t1"), entry("a", "t1", "thinking")],
      [key("a", "t2"), entry("a", "t2", "waiting")],
    ]);
    const snap = buildNotchSnapshot(inputs({ bots: [bot("a")], activity }));
    expect(snap.working).toHaveLength(1);
    expect(snap.working[0]).toMatchObject({ threadId: "t2", state: "waiting" });
  });

  it("leaves out the thread already on screen, hidden bots and resting threads", () => {
    const activity = new Map([
      [key("a", "t1"), entry("a", "t1", "tool")],
      [key("b", "t2"), entry("b", "t2", "tool")],
      [key("c", "t3"), entry("c", "t3", "idle")],
    ]);
    const snap = buildNotchSnapshot(inputs({ bots: [bot("a"), bot("b", { hidden: true }), bot("c")], activity, hiddenThreadId: "t1" }));
    expect(snap.working).toEqual([]);
    expect(snap.bots.b).toBeUndefined();
    expect(snap.shelf.map((row) => row.id)).toEqual(["a", "c"]);
  });

  it("keeps asks and moments for the open thread off the notch", () => {
    const snap = buildNotchSnapshot(inputs({
      bots: [bot("a")],
      inbox: [ask({ requestId: "r1", approval: true }), ask({ id: "i2", threadId: "t9", requestId: "r2", approval: true })],
      moments: [{ id: "m", kind: "done", botId: "a", threadId: "t1", title: "", at: 1 }],
      hiddenThreadId: "t1",
    }));
    expect(snap.asks.map((item) => item.id)).toEqual(["i2#r2#"]);
    expect(snap.moments).toEqual([]);
  });

  it("falls back to busy tasks from a server without the feed", () => {
    const snap = buildNotchSnapshot(inputs({
      bots: [bot("a", { tasks: [{ threadId: "t1", title: "report", busy: true, turnStartedAt: 7 }] as never })],
    }));
    expect(snap.working[0]).toMatchObject({ id: "a", threadId: "t1", state: "thinking", since: 7, title: "report" });
  });
});

describe("notchAsk", () => {
  it("turns a live approval into allow/deny", () => {
    expect(notchAsk(ask({ requestId: "r1", approval: true }), prefs)).toMatchObject({ kind: "approval", freeText: false, chime: true, preview: "run pnpm build" });
  });

  it("names the exact request, so a conversation's next ask is a different one", () => {
    const first = notchAsk(ask({ requestId: "r1", approval: true }), prefs)!;
    const next = notchAsk(ask({ requestId: "r2", approval: true }), prefs)!;
    expect(first.id).toBe(askKey({ id: "i1", requestId: "r1" }));
    expect(first.id).not.toBe(next.id);
  });

  it("lets a plain live question take typed words, but not in a room", () => {
    expect(notchAsk(ask({ kind: "question", requestId: "r1", freeText: true }), prefs)?.freeText).toBe(true);
    expect(notchAsk(ask({ kind: "question", requestId: "r1", freeText: true, groupId: "g" }), prefs)).toBeNull();
  });

  it("leaves proposals and question sets to their full card", () => {
    // the inbox gives those a requestId and nothing else to answer with
    expect(notchAsk(ask({ kind: "question", requestId: "r1" }), prefs)).toBeNull();
    expect(notchAsk(ask({ requestId: "r1" }), prefs)).toBeNull();
  });

  it("keeps a card with options, drops rows nobody can answer here", () => {
    const long = `${"word ".repeat(20)}end`;
    const options = notchAsk(ask({ kind: "question", messageId: "m", options: ["a  b", long] }), prefs)?.options;
    expect(options?.map((option) => option.value)).toEqual(["a  b", long]);
    expect(options?.[1]?.label.length).toBeLessThanOrEqual(60);
    expect(notchAsk(ask({ kind: "question" }), prefs)).toBeNull();
    expect(notchAsk(ask({ kind: "report" as InboxItem["kind"], requestId: "r" }), prefs)).toBeNull();
    expect(notchAsk(ask({ requestId: "r", leadAction: {} as never }), prefs)).toBeNull();
  });

  it("stays silent when that kind of notice is off or sound is none", () => {
    expect(notchAsk(ask({ requestId: "r1", approval: true }), { ...prefs, approval: false })?.chime).toBe(false);
    expect(notchAsk(ask({ requestId: "r1", approval: true }), { ...prefs, sound: "none" })?.chime).toBe(false);
  });
});

describe("momentFor", () => {
  const next = (state: ActivityEntry["state"]) => entry("a", "t", state);

  it("marks a live thread coming to rest as done, and a break as failed", () => {
    expect(momentFor("tool", next("idle"), false)).toBe("done");
    expect(momentFor("thinking", next("failed"), false)).toBe("failed");
  });

  it("ignores stops, routine successes and threads that were never live", () => {
    expect(momentFor("tool", next("stopped"), false)).toBeNull();
    expect(momentFor("tool", next("idle"), true)).toBeNull();
    expect(momentFor("tool", next("failed"), true)).toBe("failed");
    expect(momentFor(undefined, next("idle"), false)).toBeNull();
    expect(momentFor("idle", next("failed"), false)).toBeNull();
  });
});
