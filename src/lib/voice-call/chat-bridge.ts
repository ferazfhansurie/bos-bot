// How the call reads and hears the bot's written chat. Pure, so tested.

import type { Message } from "@/state/store";
import type { RecalledMessage } from "./engine";

export const RECALL_LIMIT = 30;
/** async_update content is capped like Grok Bot caps written turns. */
export const LANDED_TEXT_LIMIT = 2000;

/** The last ~30 written messages, oldest first: "you" is the bot, "them" the caller. */
export function recallMessages(messages: readonly Message[], limit = RECALL_LIMIT): RecalledMessage[] {
  const written = messages.filter(
    (m) => m.kind === "text" && typeof m.text === "string" && m.text.trim().length > 0 && !m.queued,
  );
  return written.slice(-limit).map((m) => ({ who: m.role === "bot" ? "you" : "them", text: m.text!.trim() }));
}

export function capLandedText(text: string, limit = LANDED_TEXT_LIMIT): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 1).trimEnd()}…`;
}

/**
 * Bot replies that landed after a job was sent from the call and have not
 * been spoken yet. A reply counts once its turn settled: the server marks
 * the turn's last text `turnTerminal`, and an idle bot means whatever text
 * is there is final (older servers never set the flag).
 */
export function landedReplies(input: {
  messages: readonly Message[];
  sinceAt: number;
  busy: boolean;
  delivered: ReadonlySet<string>;
}): Message[] {
  return input.messages.filter(
    (m) =>
      m.role === "bot" &&
      m.kind === "text" &&
      typeof m.text === "string" &&
      m.text.trim().length > 0 &&
      m.at >= input.sinceAt &&
      !input.delivered.has(m.id) &&
      (m.turnTerminal === true || !input.busy),
  );
}
