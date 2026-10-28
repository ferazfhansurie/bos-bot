// 3.0 empty-thread mascot brain: the draft decides the mood, the mood picks a
// face and one line. Ported from the iOS EmptyMascotBrain so both apps react
// to the same words the same way. Pure, so it is tested without a DOM.
import type { GlyphFaceState } from "../../../shared/glyph-faces";
import type { LocaleKey } from "@/locales";

export type Mood = "idle" | "listening" | "scared" | "alert" | "thanks" | "nodding" | "suspicious" | "drowsy" | "asleep";

const SCARED = new Set([
  "bug", "bugs", "buggy", "broken", "broke", "breaks", "error", "errors", "crash", "crashed", "crashes",
  "crashing", "fail", "failed", "failing", "fails", "failure", "outage", "rosak",
]);
const ALERT = new Set(["urgent", "urgently", "asap", "emergency", "hurry"]);
const THANKS = new Set(["thanks", "thank", "thx", "ty", "tysm", "appreciate", "appreciated", "terima", "tq"]);

/** Seconds of no input before the mascot dozes, then sleeps. */
export const DROWSY_S = 30;
export const ASLEEP_S = 90;

export function moodFor({ text, previous, focused, idleS }: { text: string; previous: string; focused: boolean; idleS: number }): Mood {
  const lowered = text.toLowerCase();
  const words = new Set(lowered.split(/[^a-z0-9']+/).filter(Boolean));
  const has = (set: Set<string>) => [...words].some((word) => set.has(word));
  if (has(SCARED) || lowered.includes("not working")) return "scared";
  if (has(ALERT)) return "alert";
  if (has(THANKS)) return "thanks";
  // a big chunk deleted at once reads as second thoughts
  if (previous.length - text.length > 40) return "suspicious";
  if (text.length > 180) return "nodding";
  if (focused || text.length > 0) return idleS >= ASLEEP_S && !focused ? "asleep" : "listening";
  if (idleS >= ASLEEP_S) return "asleep";
  if (idleS >= DROWSY_S) return "drowsy";
  return "idle";
}

export const MOOD_FACE: Record<Mood, GlyphFaceState> = {
  idle: "idle",
  listening: "idle",
  scared: "failed",
  alert: "working",
  thanks: "happy",
  nodding: "thinking",
  suspicious: "waiting",
  drowsy: "asleep",
  asleep: "asleep",
};

/** Which locale line set a mood reads from; idle depends on the hour. */
export function lineKey(mood: Mood, now: Date): LocaleKey {
  if (mood !== "idle") return `v3.empty.${mood}`;
  const hour = now.getHours();
  if (hour >= 23 || hour < 5) return "v3.empty.late";
  if (now.getDay() === 5) return "v3.empty.friday";
  if (hour < 11) return "v3.empty.morning";
  return "v3.empty.arrive";
}

/** djb2: the same thread and mood always pick the same line. */
export function pick<T>(options: readonly T[], seed: string): T {
  let hash = 5381;
  for (let i = 0; i < seed.length; i += 1) hash = ((hash << 5) + hash + seed.charCodeAt(i)) | 0;
  return options[Math.abs(hash) % options.length];
}

/** Up to three of the bot's own recent threads with a real title and a
 * real ask in them; none when there is nothing real to offer. */
export function recentChips<T extends { threadId: string; title?: string; archivedAt?: number; routineRunId?: string; lastUserMessageAt?: number; lastActivityAt?: number }>(
  tasks: readonly T[] | undefined,
  currentThreadId: string,
): T[] {
  return (tasks ?? [])
    .filter((task) => task.threadId !== currentThreadId && !task.archivedAt && !task.routineRunId && task.lastUserMessageAt && task.title?.trim())
    .sort((a, b) => (b.lastActivityAt ?? b.lastUserMessageAt ?? 0) - (a.lastActivityAt ?? a.lastUserMessageAt ?? 0))
    .slice(0, 3);
}
