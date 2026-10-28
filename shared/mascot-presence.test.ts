import { describe, expect, it } from "vitest";
import { turnGesture, type MascotGesture } from "./mascot-choreography";
import {
  derivePresence, FEED_GESTURE, feedActivityFor, gestureForPresence, PRESENCE_STATES, PRESENCE_SURFACES,
  type FeedActivity,
} from "./mascot-presence";
import { GLYPH_FACE_STATES, type GlyphFaceState } from "./glyph-faces";

const FEED: FeedActivity[] = ["idle", "thinking", "tool", "typing", "waiting", "failed", "stopped"];

// the sidebar row before the presence model, verbatim
function oldSidebar(state: FeedActivity, finishing: boolean, offline: boolean, resting: GlyphFaceState) {
  const active = FEED_GESTURE[state] !== "idle";
  const gesture: MascotGesture = active ? FEED_GESTURE[state] : finishing ? "finished" : "idle";
  const face = offline ? "asleep" : state === "failed" ? "failed" : resting;
  return { gesture, face };
}

describe("mascot presence", () => {
  it("covers every glyph face, and names the surfaces", () => {
    expect([...PRESENCE_STATES]).toEqual([...GLYPH_FACE_STATES]);
    expect(PRESENCE_SURFACES).toContain("sidebar");
    expect(PRESENCE_SURFACES).toContain("island");
  });

  it("gives the sidebar the same gesture and resting face it had before", () => {
    for (const state of FEED) for (const finishing of [false, true]) for (const offline of [false, true]) {
      for (const resting of GLYPH_FACE_STATES) {
        const old = oldSidebar(state, finishing, offline, resting);
        const presence = derivePresence({ surface: "sidebar", feed: state, finishing, offline, resting });
        expect(gestureForPresence(presence)).toBe(old.gesture);
        // the still face only shows when nothing moves
        if (old.gesture === "idle") expect(presence.state).toBe(old.face);
      }
    }
  });

  it("plays the turn exactly as turnGesture did", () => {
    const turns = [
      {}, { waiting: true }, { toolInFlight: true }, { toolInFlight: true, toolName: "WebSearch" },
      { toolInFlight: true, toolName: "Bash" }, { toolInFlight: false, toolName: "Grep" },
      { toolInFlight: true, toolName: "Read" }, { toolInFlight: true, toolName: "Write" }, { toolInFlight: true, toolName: "WebFetch" },
    ];
    for (const turn of turns) {
      const presence = derivePresence({ surface: "island", turn, feed: "failed", resting: "happy" });
      expect(presence.live).toBe(true);
      expect(gestureForPresence(presence)).toBe(turnGesture(turn));
    }
  });

  it("plays the exact tool pose while its state stays a shared face", () => {
    const reading = derivePresence({ surface: "island", turn: { toolInFlight: true, toolName: "Read" } });
    expect(reading).toEqual({ state: "reading", surface: "island", live: true });
    expect(gestureForPresence(reading)).toBe("reading");
    expect(PRESENCE_STATES).toContain(reading.state);
    const writing = derivePresence({ surface: "island", turn: { toolInFlight: true, toolName: "Edit" } });
    expect([writing.state, gestureForPresence(writing)]).toEqual(["writing", "writing"]);
    const browsing = derivePresence({ surface: "island", turn: { toolInFlight: true, toolName: "mcp__browser__agent_browser_open" } });
    expect([browsing.state, gestureForPresence(browsing)]).toEqual(["searching", "browsing"]);
    expect(gestureForPresence({ ...reading, live: false })).toBe("idle");
  });

  it("finishes in one beat, then rests", () => {
    expect(derivePresence({ surface: "island", finishing: true })).toEqual({ state: "finished", surface: "island", live: true });
    expect(derivePresence({ surface: "header", resting: "waiting" })).toEqual({ state: "waiting", surface: "header", live: false });
    expect(gestureForPresence(derivePresence({ surface: "header", resting: "waiting" }))).toBe("idle");
  });

  it("carries where it points and what it says", () => {
    expect(derivePresence({ surface: "cursor", turn: { toolInFlight: true }, pointingAt: "composer", label: "working" }))
      .toEqual({ state: "working", surface: "cursor", live: true, pointingAt: "composer", label: "working" });
  });

  it("ranks the feed with waiting first and falls back to the harness's tasks", () => {
    expect(feedActivityFor([], [])).toBe("idle");
    expect(feedActivityFor([{ threadId: "a", state: "tool" }, { threadId: "b", state: "waiting" }], [])).toBe("waiting");
    expect(feedActivityFor([{ threadId: "a", state: "idle" }], [{ threadId: "a", busy: true }])).toBe("idle");
    expect(feedActivityFor([], [{ threadId: "a", busy: true }])).toBe("thinking");
    expect(feedActivityFor([], [{ threadId: "a", activity: "waiting-on-you" }, { threadId: "b", activity: "working" }])).toBe("waiting");
  });
});
