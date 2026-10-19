import { describe, expect, it } from "vitest";
import { compactThreads, stepThread, threadTime } from "./CompactBotThreads";
import { RAIL_OPEN_DELAY, railOpenDelay } from "./RailThreads";
import type { Task } from "@/state/store";
const tasks: Task[] = Array.from({ length: 9 }, (_, i) => ({ threadId: `${i}`, title: `${i}`, createdAt: i + 1, lastUserMessageAt: (i + 1) * 100 }));
describe("compact thread navigation", () => {
  it("caps at five, prioritizes pins and retains the selected old thread", () => {
    expect(compactThreads(tasks, ["2"], "0").map(t => t.threadId)).toEqual(["2", "8", "7", "6", "0"]);
  });
  it("sorts by the person's message, never a later bot activity", () => {
    expect(compactThreads([{ ...tasks[0], lastActivityAt: 99999 }, tasks[1]], [], "1").map(t => t.threadId)).toEqual(["1", "0"]);
  });
  it("hides archived and routine history without losing the selected conversation", () => {
    expect(compactThreads([{ ...tasks[0], archivedAt: 1 }, { ...tasks[1], routineRunId: "r" }, tasks[2]], [], "2").map(t => t.threadId)).toEqual(["2"]);
  });
  it("includes a year for old history", () => {
    expect(threadTime(new Date(2024, 0, 3).getTime(), new Date(2026, 0, 3).getTime())).toContain("2024");
  });
  it("steps through threads in list order and wraps, past the five-row cap", () => {
    expect(stepThread(tasks, ["2"], "2", 1)?.threadId).toBe("8");
    expect(stepThread(tasks, ["2"], "2", -1)?.threadId).toBe("0");
    expect(stepThread(tasks, [], "1", 1)?.threadId).toBe("0");
    expect(stepThread([tasks[0]], [], "0", 1)).toBeUndefined();
  });
  it("opens the rail flyout after a pause, at once while skimming", () => {
    expect(railOpenDelay(10_000, 0)).toBe(RAIL_OPEN_DELAY);
    expect(railOpenDelay(10_000, 9_800)).toBe(0);
  });
});
