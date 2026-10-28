import { describe, expect, it } from "vitest";
import { FLAT_MASCOT_BODIES } from "./flat-mascot-bodies";
import { GESTURE_FACE_STATE, GESTURE_TIMING, gesturePose, IDLE_POSE, morphBodyPath, resolveGesture, mixPose, toolGesture, turnGesture } from "./mascot-choreography";
import { GLYPH_FACES } from "./glyph-faces";

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

describe("tool poses", () => {
  it("maps the real tool name of the in-flight tool to its pose", () => {
    const cases: Record<string, string> = {
      Read: "reading", read_file: "reading", NotebookRead: "reading", "mcp__fs__read_file": "reading",
      WebSearch: "searching", "mcp__exa__web_search": "searching", Grep: "searching", Glob: "searching",
      "mcp__browser__agent_browser_open": "browsing", "mcp__browser__agent_browser_snapshot": "browsing",
      agent_browser_click: "browsing", WebFetch: "browsing", "mcp__computer__click": "browsing",
      Write: "writing", Edit: "writing", MultiEdit: "writing", apply_patch: "writing", str_replace_based_edit_tool: "writing",
      Bash: "working", exec_command: "working", "mcp__computer__get_window_state": "working",
      "mcp__agents__coordinate_bots": "working", "": "working",
    };
    for (const [name, pose] of Object.entries(cases)) expect([name, toolGesture(name)]).toEqual([name, pose]);
    expect(turnGesture({ toolInFlight: true, toolName: "Read" })).toBe("reading");
    expect(turnGesture({ toolInFlight: true, toolName: "Edit", waiting: true })).toBe("waiting");
    expect(turnGesture({ toolInFlight: false, toolName: "Edit" })).toBe("thinking");
  });

  it("every tool pose loops, comes back to rest, and wears a shared face", () => {
    for (const gesture of ["reading", "browsing", "writing"] as const) {
      const [play, rest] = GESTURE_TIMING[gesture];
      expect(gesturePose(gesture, 0)).toEqual(IDLE_POSE);
      expect(gesturePose(gesture, play + rest / 2)).toEqual(IDLE_POSE);
      const mid = gesturePose(gesture, play * .5);
      expect(mid).not.toEqual(IDLE_POSE);
      expect(Object.values(gesturePose(gesture, 0, true)).every(Number.isFinite)).toBe(true);
      expect(GLYPH_FACES[GESTURE_FACE_STATE[gesture]]).toBeDefined();
    }
    // reading scans left to right more than once
    const xs = [.1, .26, .35, .55].map((t) => gesturePose("reading", GESTURE_TIMING.reading[0] * t).gx);
    expect(xs[0]).toBeLessThan(0); expect(xs[1]).toBeGreaterThan(0); expect(xs[2]).toBeLessThan(0); expect(xs[3]).toBeGreaterThan(0);
    // writing looks down
    expect(gesturePose("writing", GESTURE_TIMING.writing[0] * .3).gy).toBeGreaterThan(4);
  });

  it("knocks once every 8s while it needs you", () => {
    const [play, rest] = GESTURE_TIMING.waiting;
    expect(rest).toBe(8000);
    const settled = gesturePose("waiting", 900);
    expect(gesturePose("waiting", 900 + play / 4).dy).toBeGreaterThan(settled.dy);
    expect(gesturePose("waiting", 900 + play + 2000)).toEqual(settled);
    expect(gesturePose("waiting", 900 + rest + play / 4).dy).toBeGreaterThan(settled.dy);
  });
});
