import { describe, expect, it } from "vitest";
import { FLAT_MASCOT_BODIES } from "./flat-mascot-bodies";
import { gesturePose, IDLE_POSE, morphBodyPath, resolveGesture, mixPose, turnGesture } from "./mascot-choreography";

describe("mascot choreography", () => {
  it("returns original outline after each short gesture and never loops completion", () => {
    expect(gesturePose("thinking", 2000)).toEqual(IDLE_POSE);
    expect(gesturePose("searching", 2000)).toEqual(IDLE_POSE);
    expect(gesturePose("working", 2500)).toEqual(IDLE_POSE);
    expect(gesturePose("finished", 901)).toEqual(IDLE_POSE);
    expect(gesturePose("finished", 10000)).toEqual(IDLE_POSE);
  });
  it("retains every catalog outline at rest and creates finite compatible morphs", () => {
    for (const body of FLAT_MASCOT_BODIES) {
      expect(morphBodyPath(body.path, 0)).toBe(body.path);
      expect(morphBodyPath(body.path, .8)).not.toMatch(/NaN|Infinity/);
      expect(morphBodyPath(body.path, .8)).toMatch(/^M.* Z$/);
    }
  });
  it("waiting dominates working and completion requires one new actual terminal turn", () => {
    let state = { gesture: "idle" as const, terminalTurnId: null as string | null };
    expect(resolveGesture({ working: true, waiting: true }, state).gesture).toBe("waiting");
    const first = resolveGesture({ terminalTurnId: "turn-a" }, state);
    expect(first.gesture).toBe("finished");
    expect(resolveGesture({ terminalTurnId: "turn-a", reconnect: true }, first).gesture).toBe("idle");
    expect(resolveGesture({ terminalTurnId: "turn-a" }, first).gesture).toBe("idle");
    expect(resolveGesture({ terminalTurnId: "turn-b", reconnect: true }, first).gesture).toBe("idle");
    expect(resolveGesture({ terminalTurnId: "turn-b" }, first).gesture).toBe("finished");
    const replay = resolveGesture({ terminalTurnId: "turn-b", reconnect: true }, first);
    expect(resolveGesture({ terminalTurnId: "turn-b" }, replay).gesture).toBe("idle");
  });
  it("interrupted transition starts at displayed pose and reaches new pose smoothly", () => {
    const from = gesturePose("thinking", 700), to = gesturePose("waiting", 1000);
    expect(mixPose(from, to, 0)).toEqual(from);
    expect(mixPose(from, to, 1)).toEqual(to);
    expect(gesturePose("working", 900).split).toBeGreaterThan(.5);
  });
});

describe("live turn gesture", () => {
  it("reads only real turn signals, with a wait on someone winning", () => {
    expect(turnGesture({})).toBe("thinking");
    expect(turnGesture({ toolInFlight: true, toolName: "Bash" })).toBe("working");
    expect(turnGesture({ toolInFlight: true, toolName: "WEB_SEARCH" })).toBe("searching");
    expect(turnGesture({ toolInFlight: false, toolName: "web_search" })).toBe("thinking");
    expect(turnGesture({ waiting: true, toolInFlight: true, toolName: "Bash" })).toBe("waiting");
  });
});
