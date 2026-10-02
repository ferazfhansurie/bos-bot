// Server-side brakes that keep a room of bots from talking in circles.
// Instructions can ask bots to stay quiet; these hold even when they don't.

/** Most bot replies a room runs in a row before a human has to speak. */
export const MAX_BOT_RUN = 3;

/** "stop", "/stop", "Stop." — the whole message, nothing else. */
export function isRoomStopCommand(text: string): boolean {
  return /^\s*\/?stop[.!]*\s*$/i.test(text);
}

const ACK = new Set([
  "ok", "okay", "k", "kk", "agreed", "agree", "sounds good", "got it", "noted", "thanks", "thank you",
  "ty", "cool", "great", "nice", "done", "ack", "acknowledged", "will do", "on it", "yep", "yes", "roger",
  "copy", "same", "+1", "👍", "lgtm", "perfect", "understood",
]);

/** A reply that only acknowledges ("ok", "agreed @Jarvis", "👍") and so
 * must not summon anyone, even if it names them. */
export function isBareAck(text: string): boolean {
  const core = text
    .toLowerCase()
    .replace(/@[\p{L}\p{N}_-]+/gu, " ")
    .replace(/[^\p{L}\p{N}+👍 ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!core) return true;
  // Peel known phrases off the front until nothing (ack) or something else
  // (real content) is left: "ok thanks", "agreed sounds good".
  let rest = core;
  while (rest) {
    const words = rest.split(" ");
    const two = words.slice(0, 2).join(" ");
    if (words.length >= 2 && ACK.has(two)) rest = words.slice(2).join(" ");
    else if (ACK.has(words[0]!)) rest = words.slice(1).join(" ");
    else return false;
  }
  return true;
}

type BrakeMessage = { role: string; kind?: string; text?: string };

/** Bot replies posted since the last human message (activity rows ignored). */
export function trailingBotReplies(messages: readonly BrakeMessage[]): number {
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.kind && message.kind !== "text") continue;
    if (message.role === "user") break;
    if (message.role === "bot" && message.text?.trim()) count++;
  }
  return count;
}
