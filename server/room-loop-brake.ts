// Room Stop commands, acknowledgement filtering and deferred mention routing.

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

/** Mentions of members who already spoke in a chain, keyed by that chain's
 * `spoken` set. A chain gets one callback at most, so two bots tagging each
 * other still stop after a single reply back instead of ping-ponging. */
const mentionCallbacks = new WeakMap<Set<string>, { pending: Map<string, number>; done: Set<string> }>();

export function deferMentionCallback(spoken: Set<string>, botId: string, hop: number): void {
  let entry = mentionCallbacks.get(spoken);
  if (!entry) mentionCallbacks.set(spoken, entry = { pending: new Map(), done: new Set() });
  if (entry.done.size || entry.pending.size) return;
  entry.pending.set(botId, hop);
}

/** Next deferred callback for a settled chain, marked done so it never repeats. */
export function takeMentionCallback(spoken: Set<string>): { botId: string; hop: number } | null {
  const entry = mentionCallbacks.get(spoken);
  const next = entry?.pending.entries().next();
  if (!entry || !next || next.done) return null;
  const [botId, hop] = next.value;
  entry.pending.delete(botId);
  entry.done.add(botId);
  return { botId, hop };
}
