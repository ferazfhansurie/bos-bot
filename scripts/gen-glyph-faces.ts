/**
 * Writes shared/glyph-faces.json, its iOS and Android copies, and the iOS
 * parity fixture from shared/glyph-faces.ts.
 *
 * Run with `pnpm gen:glyphs`; `--check` exits 1 instead of writing when any
 * file is stale. shared/glyph-faces.test.ts holds the copies to the same bytes.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GLYPH_FACE_STATES, glyphFacesJson, glyphInk, glyphStateFor, resolveMausColor } from "../shared/glyph-faces.ts";

const at = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const TABLE = ["../shared/glyph-faces.json", "../ios/Sources/CompanionCore/Resources/glyph-faces.json", "../android/app/src/main/assets/glyph-faces.json"];

/** Names the iOS port must map exactly like desktop: legacy names, sheet aliases, every face, junk. */
const PARITY_EXPRESSIONS: Array<string | null> = [
  "idle", "thinking", "searching", "working", "waiting", "finished", "happy", "failed", "sleeping", "waking", "listening", "excited",
  "surprised", "suspicious", "angry", "drowsy", "curious", "confused", "bored", "proud", "shy", "sad", "laughing", "scared", "playful",
  "celebrate", "orbit", "radar", "progress", "thinking-dots", "spawning", "humming", "loading", "dictating", "writing", "sending",
  "receiving", "uploading", "notifying", "alerting", "dragging", "bouncing", "powering-down", "deadpan", "friendly", "focused", "sleepy",
  "skeptical", "worried", "mischievous", "none", "arrive", "switch", "customize", "alert", "launch", "success", "blink", "surprise",
  "failure", "pending", "thanked", "stopped", "error", "dead",
  "rest", "needs-you", "done", "nailed", "mind blown", "handoff", "kaching", "waking-up", "browsing", "reading", "ringing", "speaking",
  ...GLYPH_FACE_STATES,
  "junk", "", null, "toString", "constructor",
];
const PARITY_ACTIVITIES = [null, "working", "waiting-on-you", "idle", "no-signal", "dead"];
const PARITY_COLORS = ["green", "white", "gray", "yellow", "#1e1e2e", "#ffffff", "#000000", "#7FDBFF", "#12345", "#GGGGGG", "purple ", "blue", null, "", "#abcdef"];

function parityJson(): string {
  const expressions = [...new Set(PARITY_EXPRESSIONS)];
  const states = expressions.flatMap((expression) => PARITY_ACTIVITIES.map((activity) => ({ expression, activity, state: glyphStateFor(expression, activity) })));
  const colors = PARITY_COLORS.map((color) => ({ color, resolved: resolveMausColor(color), ink: glyphInk(color ?? "") }));
  return `${JSON.stringify({ states, colors }, null, 1)}\n`;
}

const outputs: Array<[string, string]> = [
  ...TABLE.map((path): [string, string] => [at(path), glyphFacesJson()]),
  [at("../ios/Tests/CompanionCoreTests/Fixtures/glyph-parity.json"), parityJson()],
];

const check = process.argv.includes("--check");
let stale = 0;
for (const [target, body] of outputs) {
  let current: string | null = null;
  try { current = readFileSync(target, "utf8"); } catch { /* missing */ }
  if (current === body) continue;
  stale++;
  if (check) console.error(`stale: ${target}`);
  else { writeFileSync(target, body); console.log(`wrote ${target}`); }
}
if (check && stale) process.exit(1);
