import { describe, expect, it } from "vitest";
import type { ActivityItem } from "../shared/activity.ts";
import { LiveFeed } from "./live-feed.ts";

const tool = (name: string, input: unknown, at: number) => ({ kind: "activity", at, tool: { name, input: JSON.stringify(input) } });
const item = (state: ActivityItem["state"], since: number, threadId = "t1"): ActivityItem => ({ botId: "b", threadId, roomId: null, state, since });

describe("LiveFeed", () => {
  it("adds the plain step, plan and one job clock to a busy thread", () => {
    const feed = new LiveFeed();
    const tail = [tool("TodoWrite", { todos: [{ content: "a", status: "completed" }, { content: "b", status: "in_progress" }, { content: "c", status: "pending" }] }, 1_000),
      tool("Read", { file_path: "/x/retry.ts" }, 1_200)];
    const [first] = feed.enrich([item("tool", 1_000)], () => tail, 1_500);
    expect(first).toMatchObject({ jobSince: 1_000, step: "reading retry.ts", stepIndex: 2, stepCount: 3 });
    // the state changes and its since resets; the job clock does not
    const [later] = feed.enrich([item("typing", 5_000)], () => tail, 5_000);
    expect(later.jobSince).toBe(1_000);
  });

  it("keeps the last real step when nothing new is found, and forgets a finished job", () => {
    const feed = new LiveFeed();
    feed.enrich([item("tool", 1_000)], () => [tool("WebSearch", {}, 1_100)], 1_200);
    const [held] = feed.enrich([item("thinking", 2_000)], () => [], 2_000);
    expect(held.step).toBe("searching the web");
    const [idle] = feed.enrich([item("idle", 3_000)], () => [], 3_000);
    expect(idle.step).toBeUndefined();
    const [fresh] = feed.enrich([item("thinking", 4_000)], () => [], 4_000);
    expect(fresh).toMatchObject({ jobSince: 4_000 });
    expect(fresh.step).toBeUndefined();
  });

  it("peek reads the last fields without starting a clock", () => {
    const feed = new LiveFeed();
    expect(feed.peek([item("tool", 1_000)])[0].jobSince).toBeUndefined();
    feed.enrich([item("tool", 1_000)], () => [tool("WebSearch", {}, 1_100)], 1_200);
    expect(feed.peek([item("tool", 9_000)])[0]).toMatchObject({ jobSince: 1_000, step: "searching the web" });
  });
});
