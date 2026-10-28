// 3.0 thread worker brain: what the bot standing at the end of the thread
// shows while a turn runs. Pure, so it is tested without a DOM.
import type { Message } from "@/state/store";

/** A tool the turn ran (not a bot⇄bot chip, not a failed-turn row). */
function isStep(message: Message): boolean {
  return message.kind === "activity" && Boolean(message.tool) && !message.comm && !message.tool!.name.startsWith("error:");
}

/** The running turn's tool steps: everything after the person's last
 * message that started a turn (a mid-turn send joins the turn, it does
 * not start a new one). */
export function turnSteps(messages: readonly Message[]): Message[] {
  let start = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (message.role === "user" && !message.steered) {
      start = i + 1;
      break;
    }
  }
  return messages.slice(start).filter(isStep);
}

/** The last few finished steps, oldest first: the faded trail. */
export function doneTrail(steps: readonly Message[], size = 3): Message[] {
  return steps.filter((step) => step.tool?.ok !== undefined).slice(-size);
}

export type SteerRead = "waiting" | "read";

/** Each mid-turn send's state for its bubble. Words the turn took count as
 * read once anything new lands after them: a tool already running only
 * updates its own row, so the next new row comes from a model call that
 * had the words in it. steerDelivery is admission, never proof of reading,
 * so it alone never marks one read; an unknown delivery keeps its own
 * warning and is left out here. A turn that ended took them too. */
export function steerReads(messages: readonly Message[], busy: boolean): Map<string, SteerRead> {
  const reads = new Map<string, SteerRead>();
  let laterNews = !busy;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (message.role !== "user") {
      laterNews = true;
      continue;
    }
    if (!message.steered || message.steerDelivery === "outcome_unknown") continue;
    reads.set(message.id, laterNews ? "read" : "waiting");
  }
  return reads;
}

/** When something last happened in the turn: the newest row or the start. */
export function lastNewsAt(messages: readonly Message[], since: number | null): number | null {
  if (since === null) return null;
  const last = messages.at(-1);
  return Math.max(since, last?.at ?? 0);
}

/** Seconds of silence before the worker says it is still on it. */
export const SLOW_S = 45;
