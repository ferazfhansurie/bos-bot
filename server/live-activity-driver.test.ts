import { describe, expect, it } from "vitest";
import type { ActivityItem } from "../shared/activity.ts";
import type { LiveActivityPush } from "./apns-push.ts";
import { LiveActivityDriver, liveViews } from "./live-activity-driver.ts";

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
