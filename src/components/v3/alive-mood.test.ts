import { describe, expect, it } from "vitest";
import { ASLEEP_S, DROWSY_S, lineKey, moodFor, pick, recentChips } from "./alive-mood";

const base = { text: "", previous: "", focused: false, idleS: 0 };

describe("moodFor", () => {
  it("reacts to the words in the draft", () => {
    expect(moodFor({ ...base, text: "the site is broken" })).toBe("scared");
    expect(moodFor({ ...base, text: "it's not working" })).toBe("scared");
    expect(moodFor({ ...base, text: "need this asap" })).toBe("alert");
    expect(moodFor({ ...base, text: "thanks man" })).toBe("thanks");
  });
  it("reads a big delete as second thoughts and a long draft as nodding", () => {
    expect(moodFor({ ...base, text: "hi", previous: "x".repeat(60) })).toBe("suspicious");
    expect(moodFor({ ...base, text: "a".repeat(200), previous: "a".repeat(199) })).toBe("nodding");
  });
  it("listens while focused and dozes when left alone", () => {
    expect(moodFor({ ...base, focused: true })).toBe("listening");
    expect(moodFor({ ...base, idleS: DROWSY_S })).toBe("drowsy");
    expect(moodFor({ ...base, idleS: ASLEEP_S })).toBe("asleep");
    expect(moodFor({ ...base })).toBe("idle");
  });
});

describe("lineKey", () => {
  it("picks idle lines by the hour", () => {
    expect(lineKey("idle", new Date(2026, 9, 26, 23, 30))).toBe("v3.empty.late");
    expect(lineKey("idle", new Date(2026, 9, 30, 14))).toBe("v3.empty.friday");
    expect(lineKey("idle", new Date(2026, 9, 26, 9))).toBe("v3.empty.morning");
    expect(lineKey("idle", new Date(2026, 9, 26, 15))).toBe("v3.empty.arrive");
    expect(lineKey("thanks", new Date())).toBe("v3.empty.thanks");
  });
});

describe("pick", () => {
  it("is stable for a seed", () => {
    const options = ["a", "b", "c", "d"];
    expect(pick(options, "t1:idle")).toBe(pick(options, "t1:idle"));
  });
});

describe("recentChips", () => {
  it("offers only real recent threads, newest first, at most three", () => {
    const tasks = [
      { threadId: "now", title: "current", lastUserMessageAt: 9 },
      { threadId: "a", title: "old", lastUserMessageAt: 1, lastActivityAt: 1 },
      { threadId: "b", title: "new", lastUserMessageAt: 5, lastActivityAt: 8 },
      { threadId: "c", title: "", lastUserMessageAt: 6 },
      { threadId: "d", title: "routine", lastUserMessageAt: 6, routineRunId: "r" },
      { threadId: "e", title: "gone", lastUserMessageAt: 6, archivedAt: 7 },
      { threadId: "f", title: "never asked" },
      { threadId: "g", title: "mid", lastUserMessageAt: 3, lastActivityAt: 4 },
      { threadId: "h", title: "older", lastUserMessageAt: 2, lastActivityAt: 2 },
    ];
    expect(recentChips(tasks, "now").map((task) => task.threadId)).toEqual(["b", "g", "h"]);
    expect(recentChips([], "now")).toEqual([]);
    expect(recentChips(undefined, "now")).toEqual([]);
  });
});
