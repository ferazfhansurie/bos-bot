import { describe, expect, it } from "vitest";
import { homeAutomations, homeBoardBots, homeLanes, navigationKey } from "@/lib/v3-home";
import type { Bot } from "@/state/store";
import type { Routine, RoutineRun } from "../../shared/routines";

const bot = (id: string, tasks: Partial<NonNullable<Bot["tasks"]>[number]>[]) =>
  ({ id, name: id, tasks: tasks.map((task, i) => ({ threadId: `${id}-${i}`, title: `t${i}`, createdAt: i, ...task })) }) as unknown as Bot;

describe("homeLanes", () => {
  it("sorts threads into needs you, working and done, newest first", () => {
    const lanes = homeLanes([
      bot("a", [{ activity: "waiting-on-you" }, { busy: true }, { unread: true, lastActivityAt: 5 }, {}]),
      bot("b", [{ unread: true, lastActivityAt: 9 }, { activity: "working" }]),
    ]);
    expect(lanes.needsYou.map((e) => e.task.threadId)).toEqual(["a-0"]);
    expect(lanes.working.map((e) => e.task.threadId).sort()).toEqual(["a-1", "b-1"]);
    expect(lanes.done.map((e) => e.task.threadId)).toEqual(["b-0", "a-2"]);
  });

  it("leaves out routine runs and archived threads", () => {
    const lanes = homeLanes([bot("a", [{ unread: true, routineRunId: "r" }, { activity: "waiting-on-you", archivedAt: 1 }])]);
    expect(lanes.needsYou).toEqual([]);
    expect(lanes.done).toEqual([]);
  });

  it("leaves out the bots hidden from the board", () => {
    const lanes = homeLanes([bot("a", [{ unread: true }, { busy: true }]), bot("b", [{ unread: true }])], ["a"]);
    expect([...lanes.needsYou, ...lanes.working, ...lanes.done].map((e) => e.bot.id)).toEqual(["b"]);
  });

  it("never files a run that couldn't start as done", () => {
    const lanes = homeLanes([bot("a", [{ unread: true, activity: "dead" }, { unread: true, activity: "no-signal" }, { unread: true, activity: "idle" }])]);
    expect(lanes.done.map((e) => e.task.threadId)).toEqual(["a-2"]);
  });
});

describe("homeBoardBots", () => {
  it("offers a switch for a hidden bot only while it has a card on the board", () => {
    const hiddenBot = (id: string, tasks: Parameters<typeof bot>[1]) => ({ ...bot(id, tasks), hidden: true }) as Bot;
    const bots = [bot("a", []), hiddenBot("cards", [{ unread: true }]), hiddenBot("quiet", [{ unread: false }])];
    expect(homeBoardBots(bots, [], []).map((b) => b.id)).toEqual(["a", "cards"]);
  });
});

describe("homeAutomations", () => {
  it("leaves out runs and routines of hidden bots", () => {
    const routines = [{ id: "1", botId: "a", enabled: true, nextRunAt: 300 }, { id: "2", botId: "b", enabled: true, nextRunAt: 200 }] as unknown as Routine[];
    const runs = [{ id: "x", botId: "a", status: "running" }, { id: "y", botId: "b", status: "queued" }] as unknown as RoutineRun[];
    const result = homeAutomations(routines, runs, 100, ["a"]);
    expect(result.live.map((run) => run.id)).toEqual(["y"]);
    expect(result.upcoming.map((routine) => routine.id)).toEqual(["2"]);
  });

  it("keeps live runs and the enabled routines still to come, soonest first", () => {
    const routines = [
      { id: "1", enabled: true, nextRunAt: 300 },
      { id: "2", enabled: false, nextRunAt: 200 },
      { id: "3", enabled: true, nextRunAt: 150 },
      { id: "4", enabled: true, nextRunAt: 50 },
    ] as unknown as Routine[];
    const runs = [{ id: "x", status: "running" }, { id: "y", status: "completed" }] as unknown as RoutineRun[];
    const result = homeAutomations(routines, runs, 100);
    expect(result.live.map((run) => run.id)).toEqual(["x"]);
    expect(result.upcoming.map((routine) => routine.id)).toEqual(["3", "1"]);
  });
});

describe("navigationKey", () => {
  it("changes with the view, bot, thread or room", () => {
    const base = { activeView: "chat", selectedId: "a", threadId: "t", sharedRoomId: null };
    expect(navigationKey(base)).toBe(navigationKey({ ...base }));
    expect(navigationKey(base)).not.toBe(navigationKey({ ...base, threadId: "u" }));
    expect(navigationKey(base)).not.toBe(navigationKey({ ...base, activeView: "routines" }));
  });
});
