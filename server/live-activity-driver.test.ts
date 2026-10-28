import { describe, expect, it } from "vitest";
import type { ActivityItem } from "../shared/activity.ts";
import type { LiveActivityPush } from "./apns-push.ts";
import { LiveActivityDriver, liveAsk, liveResult, liveSummary, liveViews, replyFirstLine, type LiveAsk } from "./live-activity-driver.ts";

const item = (botId: string, threadId: string, state: ActivityItem["state"], since: number): ActivityItem => ({ botId, threadId, roomId: null, state, since });

describe("liveViews", () => {
  it("shows one island per bot, a question beating work", () => {
    const views = liveViews([item("a", "t1", "tool", 2), item("a", "t2", "waiting", 1), item("b", "t3", "idle", 1)]);
    expect([...views.keys()]).toEqual(["a"]);
    expect(views.get("a")).toMatchObject({ kind: "needsYou", threadId: "t2", line: "waiting for you", otherThreads: 1 });
  });
});

describe("LiveActivityDriver", () => {
  function setup(reach: { activity: boolean; start: boolean }) {
    const sent: LiveActivityPush[] = [];
    let now = 1_000_000;
    const driver = new LiveActivityDriver({
      bot: id => ({ id, name: "bos", color: "#14b8a6" }),
      title: () => "fix the island",
      reach: () => reach,
      send: async push => { sent.push(push); },
      now: () => now,
      debounce: 60_000,
    });
    return { driver, sent, reach, tick: (ms: number) => { now += ms; } };
  }

  it("starts once, waits for the activity token, updates, then ends with a done card", async () => {
    const { driver, sent, reach, tick } = setup({ activity: false, start: true });
    driver.observe([item("a", "t1", "thinking", 1)]);
    await driver.flush();
    await driver.flush();
    expect(sent.map(push => push.event)).toEqual(["start"]);
    expect(sent[0].content).toMatchObject({ kind: "working", headline: "bos is working", threadTitle: "fix the island" });
    reach.activity = true;
    tick(1_000);
    driver.observe([item("a", "t1", "tool", 1)]);
    await driver.flush();
    expect(sent).toHaveLength(1); // a step alone waits out stepEvery
    tick(15_000);
    await driver.flush();
    expect(sent.at(-1)).toMatchObject({ event: "update", priority: 5 });
    driver.observe([item("a", "t1", "waiting", 1)]);
    await driver.flush();
    expect(sent.at(-1)).toMatchObject({ event: "update", priority: 10, alert: { title: "bos needs you" } });
    driver.observe([]);
    await driver.flush();
    expect(sent.at(-1)).toMatchObject({ event: "end", content: { kind: "done", line: "finished" } });
  });

  it("leaves the island to the app while it is on screen", async () => {
    const { driver, sent, reach } = setup({ activity: false, start: false });
    driver.observe([item("a", "t1", "thinking", 1)]);
    await driver.flush();
    expect(sent).toEqual([]);
    reach.start = true; // the app went to the background
    await driver.flush();
    expect(sent.map(push => push.event)).toEqual(["start"]);
  });
});

describe("bos bot 3.0 handoff", () => {
  function setup(reach: { activity: boolean; start: boolean }, deps: { present?: () => boolean | undefined; ask?: () => LiveAsk | undefined } = {}) {
    const sent: LiveActivityPush[] = [];
    const driver = new LiveActivityDriver({
      bot: id => ({ id, name: "bos", color: "#14b8a6" }),
      title: () => "send the invoice",
      reach: () => reach,
      send: async push => { sent.push(push); },
      now: () => 1_000_000,
      debounce: 60_000,
      ...deps,
    });
    return { driver, sent, reach };
  }
  const allow: LiveAsk = { requestId: "r1", options: ["Allow", "Deny"], isPermission: true, line: "Bash · git push" };

  it("carries the live ask so the lock screen can answer it", async () => {
    const { driver, sent } = setup({ activity: false, start: true }, { ask: () => allow });
    driver.observe([item("a", "t1", "waiting", 1)]);
    await driver.flush();
    expect(sent[0]).toMatchObject({ event: "start", content: { kind: "needsYou", requestId: "r1", options: ["Allow", "Deny"], isPermission: true, line: "Bash · git push" } });
  });

  it("sends a working bot's ask-free content exactly as before when the flag is off", async () => {
    const { driver, sent } = setup({ activity: false, start: true });
    driver.observe([item("a", "t1", "waiting", 1)]);
    await driver.flush();
    expect(sent[0].content).toMatchObject({ options: [], isPermission: false, line: "waiting for you" });
    expect(sent[0].content).not.toHaveProperty("requestId");
  });

  it("keeps a working bot on the mac while the person is there, but still sends a bot that needs you", async () => {
    const { driver, sent } = setup({ activity: false, start: true }, { present: () => true, ask: () => allow });
    driver.observe([item("a", "t1", "thinking", 1)]);
    await driver.flush();
    expect(sent).toEqual([]);
    driver.observe([item("a", "t1", "waiting", 1)]);
    await driver.flush();
    expect(sent.map(push => push.event)).toEqual(["start"]);
  });

  it("hands a working bot to the phone when the person leaves, and walks it back when they return", async () => {
    let atMac = false;
    const { driver, sent, reach } = setup({ activity: false, start: true }, { present: () => atMac });
    driver.observe([item("a", "t1", "tool", 1)]);
    await driver.flush();
    expect(sent.map(push => push.event)).toEqual(["start"]);
    reach.activity = true;
    atMac = true;
    await driver.flush();
    expect(sent.at(-1)).toMatchObject({ event: "end", dismissalDate: 1_000 });
    reach.activity = false; // the end cleared the activity token
    await driver.flush();
    expect(sent).toHaveLength(2);
    atMac = false;
    await driver.flush();
    expect(sent.at(-1)).toMatchObject({ event: "start" });
  });

  it("treats an unknown presence as away", async () => {
    const { driver, sent } = setup({ activity: false, start: true }, { present: () => undefined });
    driver.observe([item("a", "t1", "thinking", 1)]);
    await driver.flush();
    expect(sent.map(push => push.event)).toEqual(["start"]);
  });
});

describe("liveAsk", () => {
  it("offers a tool approval without the standing grant", () => {
    expect(liveAsk([{ card: { title: "Bash", subtitle: "git push", options: ["Allow", "Deny", "Always allow"], requestId: "r1", tool: "Bash" } }]))
      .toEqual({ requestId: "r1", options: ["Allow", "Deny"], isPermission: true, line: "Bash · git push" });
  });
  it("skips answered cards, proposals and cards without a live request", () => {
    expect(liveAsk([{ card: { title: "x", subtitle: "", options: ["Allow"], requestId: "r1", answered: "allow" } }])).toBeUndefined();
    expect(liveAsk([{ card: { title: "x", subtitle: "", options: ["Allow"], requestId: "r1", skillRequest: {} as never } }])).toBeUndefined();
    expect(liveAsk([{ card: { title: "x", subtitle: "", options: ["Allow"] } }])).toBeUndefined();
  });
});

describe("the car", () => {
  it("sums every busy bot in one line, and says nothing for one", () => {
    expect(liveSummary(liveViews([item("a", "t1", "tool", 1)]))).toBeUndefined();
    expect(liveSummary(liveViews([item("a", "t1", "tool", 1), item("b", "t2", "thinking", 1), item("c", "t3", "tool", 1),
      item("d", "t4", "waiting", 1)]))).toBe("3 working · 1 needs you");
    expect(liveSummary(liveViews([item("a", "t1", "waiting", 1), item("b", "t2", "waiting", 1)]))).toBe("2 need you");
  });

  it("ends with the reply's first line, and only a reply from this turn", () => {
    const reply = { role: "bot", kind: "text", text: "## ad e: rm18 spent, 2 sign-ups\nmore detail", at: 5_000 };
    expect(liveResult([reply], 4_000)).toBe("ad e: rm18 spent, 2 sign-ups");
    expect(liveResult([reply], 9_000)).toBeUndefined();
    expect(liveResult([reply, { role: "user", kind: "text", text: "ok", at: 6_000 }], 4_000)).toBeUndefined();
    expect(replyFirstLine("\n- **done** with `x`")).toBe("done with x");
  });

  it("puts the summary, the result and a relevance on the pushes", async () => {
    const sent: LiveActivityPush[] = [];
    const driver = new LiveActivityDriver({
      bot: id => ({ id, name: id, color: "#14b8a6" }), title: () => undefined,
      reach: () => ({ activity: true, start: true }), send: async push => { sent.push(push); },
      result: () => "ad e: rm18 spent, 2 sign-ups", now: () => 1_000_000, debounce: 60_000,
    });
    driver.observe([item("a", "t1", "tool", 1), item("b", "t2", "waiting", 1)]);
    await driver.flush();
    expect(sent.find(push => push.attributes.botId === "a")).toMatchObject({ relevance: 50, content: { summary: "1 working · 1 needs you" } });
    expect(sent.find(push => push.attributes.botId === "b")).toMatchObject({ relevance: 80 });
    driver.observe([item("b", "t2", "waiting", 1)]);
    await driver.flush();
    expect(sent.find(push => push.event === "end")).toMatchObject({ relevance: 10, content: { kind: "done", line: "ad e: rm18 spent, 2 sign-ups" } });
  });
});

describe("the job card", () => {
  function setup(step: () => ReturnType<NonNullable<ConstructorParameters<typeof LiveActivityDriver>[0]["step"]>>) {
    const sent: LiveActivityPush[] = [];
    let now = 1_000_000;
    const driver = new LiveActivityDriver({
      bot: id => ({ id, name: "cash", color: "#22c55e" }), title: () => "live card",
      reach: () => ({ activity: true, start: true }), send: async push => { sent.push(push); },
      step, now: () => now, debounce: 60_000,
    });
    return { driver, sent, tick: (ms: number) => { now += ms; } };
  }

  it("keeps one clock from the job's start while its state changes", async () => {
    const { driver, sent, tick } = setup(() => undefined);
    driver.observe([item("a", "t1", "thinking", 999_000)]);
    await driver.flush();
    tick(30_000);
    driver.observe([item("a", "t1", "tool", 1_029_000)]); // activity.ts resets since per state
    await driver.flush();
    tick(30_000);
    driver.observe([item("a", "t1", "typing", 1_059_000)]);
    await driver.flush();
    const starts = sent.map(push => push.content.jobSince);
    expect(new Set(starts).size).toBe(1);
    expect(sent.at(-1)?.content.since).toBe(starts[0]);
  });

  it("shows the real step with the plan, and keeps it until a new one replaces it", async () => {
    let step: { line: string; symbol: string; stepIndex?: number; stepCount?: number } | undefined = { line: "running tests", symbol: "checkmark.seal", stepIndex: 3, stepCount: 5 };
    const { driver, sent, tick } = setup(() => step);
    driver.observe([item("a", "t1", "tool", 1)]);
    await driver.flush();
    expect(sent.at(-1)?.content).toMatchObject({ line: "running tests", stepIndex: 3, stepCount: 5 });
    step = undefined; // between tools: nothing new to say
    tick(10_000);
    driver.observe([item("a", "t1", "thinking", 2)]);
    await driver.flush();
    expect(sent.at(-1)?.content).toMatchObject({ line: "running tests", stepIndex: 3 });
    expect(sent.map(push => push.content.line)).not.toContain("thinking");
  });

  it("coalesces step changes to one push every few seconds at low priority", async () => {
    let n = 0;
    const { driver, sent, tick } = setup(() => ({ line: `step ${n}`, symbol: "gearshape" }));
    driver.observe([item("a", "t1", "tool", 1)]);
    await driver.flush();
    for (let i = 0; i < 10; i += 1) { n += 1; tick(500); await driver.flush(); }
    expect(sent).toHaveLength(2); // the first card, then one step after 4s
    expect(sent.at(-1)).toMatchObject({ priority: 5 });
  });

  it("ends with the result and a full ring", async () => {
    const sent: LiveActivityPush[] = [];
    const driver = new LiveActivityDriver({
      bot: id => ({ id, name: "cash", color: "#22c55e" }), title: () => "live card",
      reach: () => ({ activity: true, start: true }), send: async push => { sent.push(push); },
      step: () => ({ line: "building the app", symbol: "hammer", stepIndex: 4, stepCount: 5 }),
      result: () => "build 150 is on your phone", now: () => 1_000_000, debounce: 60_000,
    });
    driver.observe([item("a", "t1", "tool", 1)]);
    await driver.flush();
    driver.observe([]);
    await driver.flush();
    expect(sent.at(-1)).toMatchObject({ event: "end", content: { kind: "done", result: "build 150 is on your phone", stepIndex: 5, stepCount: 5, threadTitle: "live card" } });
  });
});
