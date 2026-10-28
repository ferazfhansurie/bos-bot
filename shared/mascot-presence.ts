// One answer to "what is this bot's mascot doing, and where": a presence per
// bot per surface. Every mascot surface asks here instead of mixing the turn,
// the activity feed and the resting face on its own, so the sidebar, the
// chat header, the island under the transcript and (later) the notch, the
// phone and the home board all agree on one face.
//
// Three inputs, strongest first:
//   - a live turn in this view (turnGesture: thinking, searching, working, waiting)
//   - the activity feed across the bot's threads (botActivityState)
//   - the resting face (glyphFaceForBot: a pinned expression, a failed tool,
//     a question waiting on the person)
// plus two beats the inputs can't say alone: "finished" for the moment work
// ends cleanly, and "asleep" for a bot whose home is offline.
//
// Derived on the client today; the shape is plain data so the server can
// emit it on the event stream later without changing a reader.
import { GESTURE_FACE_STATE, turnGesture, type MascotGesture } from "./mascot-choreography";
import type { GlyphFaceState } from "./glyph-faces.ts";
import { GLYPH_FACE_STATES } from "./glyph-faces";

/** Every glyph face, so a resting bot can wear any of them (drowsy, sad). */
export const PRESENCE_STATES = GLYPH_FACE_STATES;
export type PresenceState = GlyphFaceState;

/** Where a mascot can stand. "header" is the chat title's avatar. */
export const PRESENCE_SURFACES = [
  "sidebar", "composer", "island", "tab", "cursor", "notch", "phone", "home", "header",
] as const;
export type PresenceSurface = (typeof PRESENCE_SURFACES)[number];

export interface MascotPresence {
  state: PresenceState;
  surface: PresenceSurface;
  /** what the mascot is looking at or travelling to (an element id, a tab) */
  pointingAt?: string;
  /** the words beside it ("searching the web") */
  label?: string;
  /** true while it is animating a gesture; false when it holds a still face */
  live: boolean;
  /** the exact tool pose (reading, browsing, writing) when it is finer than
   * state; state stays one of the shared face states the phone knows */
  gesture?: MascotGesture;
}

// ── the activity feed, one state per bot ──────────────────────────────────

export type FeedActivity = "idle" | "thinking" | "tool" | "typing" | "waiting" | "failed" | "stopped";

export const FEED_GESTURE: Record<FeedActivity, MascotGesture> = {
  idle: "idle", stopped: "idle", failed: "idle",
  thinking: "thinking", tool: "working", typing: "searching", waiting: "waiting",
};
// waiting needs the person most; then whatever is visibly moving
const FEED_RANK: Record<FeedActivity, number> = { waiting: 0, tool: 1, typing: 2, thinking: 3, failed: 4, stopped: 5, idle: 6 };

/** One state for a bot: the feed when a thread has an entry, else the
 * harness's task.activity so an older server still shows work. */
export function feedActivityFor(
  entries: ReadonlyArray<{ threadId: string; state: FeedActivity }>,
  tasks: ReadonlyArray<{ threadId: string; activity?: string | null; busy?: boolean | null }>,
): FeedActivity {
  const states: FeedActivity[] = entries.map((entry) => entry.state);
  const covered = new Set(entries.map((entry) => entry.threadId));
  for (const task of tasks) {
    if (covered.has(task.threadId)) continue;
    if (task.activity === "waiting-on-you") states.push("waiting");
    else if (task.activity === "working" || task.busy) states.push("thinking");
  }
  return states.sort((a, b) => FEED_RANK[a] - FEED_RANK[b])[0] ?? "idle";
}

// ── the presence ──────────────────────────────────────────────────────────

export interface PresenceInput {
  surface: PresenceSurface;
  /** a turn running in the view this surface sits in */
  turn?: { waiting?: boolean; toolInFlight?: boolean; toolName?: string | null } | null;
  /** the bot's state across all its threads */
  feed?: FeedActivity;
  /** work just ended cleanly: one settle beat */
  finishing?: boolean;
  /** the bot's home computer is offline */
  offline?: boolean;
  /** the still face when nothing is moving (glyphFaceForBot) */
  resting?: GlyphFaceState;
  pointingAt?: string;
  label?: string;
}

export function derivePresence(input: PresenceInput): MascotPresence {
  const { surface, pointingAt, label } = input;
  const at = (state: PresenceState, live: boolean): MascotPresence => ({
    state, surface, live,
    ...(pointingAt === undefined ? {} : { pointingAt }),
    ...(label === undefined ? {} : { label }),
  });
  if (input.turn) {
    const gesture = turnGesture(input.turn), state = GESTURE_FACE_STATE[gesture];
    return state === gesture ? at(state, true) : { ...at(state, true), gesture };
  }
  const fromFeed = input.feed ? FEED_GESTURE[input.feed] : "idle";
  if (fromFeed !== "idle") return at(GESTURE_FACE_STATE[fromFeed], true);
  if (input.finishing) return at("finished", true);
  if (input.offline) return at("asleep", false);
  if (input.feed === "failed") return at("failed", false);
  return at(input.resting ?? "idle", false);
}

/** The gesture an animated mascot plays: the live state, or rest. */
export function gestureForPresence(presence: MascotPresence): MascotGesture {
  return presence.live ? presence.gesture ?? presence.state as MascotGesture : "idle";
}
