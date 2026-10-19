// Grouping a transcript's tool chips into runs.
//
// A bot working through a task emits one chip per tool call, and a long
// stretch of them buries the thing you actually came to read: what the bot
// SAID. Consecutive finished steps fold into a single row that names them;
// text between two stretches breaks the run, so the bot's words always
// separate one run from the next.
import type { Message } from "@/state/store";
import { formatElapsed } from "@/lib/working-time";
import { t } from "@/lib/i18n";

export type ActivityTranscriptItem =
  | { kind: "message"; message: Message }
  | { kind: "run"; id: string; messages: Message[] };

export type TranscriptItem =
  | ActivityTranscriptItem
  | {
      kind: "turn";
      id: string;
      turnId: string;
      /** "Worked for 4m": the turn's wall time, prompt to answer. */
      label: string;
      /** Everything folded, in transcript order: narration and steps. */
      messages: Message[];
      /** The folded tool steps alone, for the "N steps" half of the label. */
      steps: Message[];
    };

/** A step that may be folded away: finished, a real tool, and not a
 * bot⇄bot or opened-thread chip (those are navigation, not work) or a
 * failed turn (that renders as an error). */
function foldable(message: Message): boolean {
  const tool = message.tool;
  if (message.kind !== "activity" || !tool) return false;
  if (message.comm || message.threadRef || tool.recovery) return false;
  if (tool.ok === undefined || tool.name === "turn failed" || tool.name === "stopped") return false;
  return !tool.name.startsWith("error:");
}

/** Pending work can share a disclosure while its header shows the live tool.
 * Outcome reviews and navigation must stay actionable in the conversation. */
function groupable(message: Message): boolean {
  if (foldable(message)) return true;
  const tool = message.tool;
  return message.kind === "activity" && Boolean(tool) && tool?.ok === undefined &&
    !message.comm && !message.threadRef && !tool?.recovery &&
    !tool?.name.startsWith("error:") && tool?.name !== "stopped" && tool?.name !== "turn failed";
}

type TurnFold = Extract<TranscriptItem, { kind: "turn" }>;

/** A settled turn folds into one reversible row: its narration (earlier
 * assistant messages of the same provider turn) and its finished tool steps,
 * from the prompt up to the terminal answer, which stays visible. Cards and bot⇄bot chips are not foldable and keep their place, so a
 * long tool-heavy turn reads as prompt, "Worked for 4m · 23 steps", answer.
 * A turn with one step and no narration is left as it is: a fold that hides
 * one chip costs more than the chip. */
function assistantTurnFolds(messages: Message[]): {
  byAnchorId: Map<string, TurnFold>;
  hiddenIds: Set<string>;
} {
  const byAnchorId = new Map<string, TurnFold>();
  const hiddenIds = new Set<string>();

  messages.forEach((terminal, terminalIndex) => {
    if (
      terminal.role !== "bot" ||
      terminal.kind !== "text" ||
      !terminal.turnId ||
      !terminal.turnTerminal
    ) return;

    // The turn began after the prompt (or the previous settled answer).
    let start = terminalIndex;
    while (start > 0) {
      const before = messages[start - 1];
      if (before.role === "user" || (before.turnTerminal && before.turnId !== terminal.turnId)) break;
      start -= 1;
    }
    const members = messages.slice(start, terminalIndex).filter((message) =>
      !hiddenIds.has(message.id) && (
        (message.role === "bot" &&
          message.kind === "text" &&
          message.turnId === terminal.turnId &&
          !message.turnTerminal) ||
        (foldable(message) && (!message.turnId || message.turnId === terminal.turnId))
      )
    );
    const steps = members.filter((message) => message.kind === "activity");
    if (members.length === steps.length && steps.length < 2) return;

    const anchor = members[0];
    const prompt = start > 0 && messages[start - 1].role === "user" ? messages[start - 1] : undefined;
    const startedAt = prompt?.at ?? anchor.at;
    const elapsed = Math.max(0, terminal.at - startedAt);
    const label =
      elapsed >= 1_000
        ? t("chat.run.workedFor", { elapsed: formatElapsed(elapsed) })
        : t("chat.run.worked");
    const fold: TurnFold = {
      kind: "turn",
      id: `turn:${terminal.turnId}`,
      turnId: terminal.turnId,
      label,
      messages: members,
      steps,
    };
    byAnchorId.set(anchor.id, fold);
    for (const message of members) hiddenIds.add(message.id);
  });

  return { byAnchorId, hiddenIds };
}

function group(messages: Message[], foldAssistantTurns: boolean): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const folds = foldAssistantTurns
    ? assistantTurnFolds(messages)
    : { byAnchorId: new Map<string, TurnFold>(), hiddenIds: new Set<string>() };
  let run: Message[] = [];
  const flush = () => {
    // one step on its own is cheaper to read than a fold that hides it
    if (run.length > 1) items.push({ kind: "run", id: `run:${run[0].id}`, messages: run });
    else for (const message of run) items.push({ kind: "message", message });
    run = [];
  };
  for (const message of messages) {
    const turn = folds.byAnchorId.get(message.id);
    if (turn) {
      flush();
      items.push(turn);
      continue;
    }
    if (folds.hiddenIds.has(message.id)) continue;
    if (groupable(message)) {
      const first = run[0];
      if (
        first &&
        (first.role !== message.role ||
          first.from?.botId !== message.from?.botId ||
          first.turnId !== message.turnId ||
          new Date(first.at).toDateString() !== new Date(message.at).toDateString())
      ) {
        flush();
      }
      run.push(message);
      continue;
    }
    flush();
    items.push({ kind: "message", message });
  }
  flush();
  return items;
}

export function groupActivityRuns(messages: Message[]): ActivityTranscriptItem[] {
  return group(messages, false) as ActivityTranscriptItem[];
}

export function groupTranscript(messages: Message[]): TranscriptItem[] {
  return group(messages, true);
}

/** Keep implementation commands inside the expanded activity details. */
export function describeRun(messages: Message[]): string {
  const count = messages.filter(message => message.tool?.ok === false).length;
  const label = t("chat.run.stepCount", { count: messages.length });
  return count ? `${label} · ${t(count === 1 ? "chat.run.incompleteOne" : "chat.run.incomplete", { count })}` : label;
}
