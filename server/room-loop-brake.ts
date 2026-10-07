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

/** Deferred mention deliveries for one user round. A distinct result may
 * wake the same lead again; repeating the same source/recipient/content route
 * may not. The caller enforces the hop limit independently of this ledger. */
const mentionCallbacks = new WeakMap<Set<string>, {
  pending: Map<string, { botId: string; hop: number; sourceBotId?: string }>;
  seen: Set<string>;
}>();

/** False when this route already ran this round (the loop brake). */
export function deferMentionCallback(spoken: Set<string>, botId: string, hop: number, sourceKey: string, sourceBotId?: string): boolean {
  let entry = mentionCallbacks.get(spoken);
  if (!entry) mentionCallbacks.set(spoken, entry = { pending: new Map(), seen: new Set() });
  const key = JSON.stringify([botId, sourceKey]);
  if (entry.seen.has(key)) return false;
  entry.seen.add(key);
  entry.pending.set(key, { botId, hop, ...(sourceBotId ? { sourceBotId } : {}) });
  return true;
}

/** The deferred delivery was steered into a running turn instead: drop it,
 * keeping the route marked seen so it cannot run again this round. */
export function dropMentionCallback(spoken: Set<string>, botId: string, sourceKey: string): boolean {
  return mentionCallbacks.get(spoken)?.pending.delete(JSON.stringify([botId, sourceKey])) ?? false;
}

/** A steer that was refused goes back to the normal deferred delivery. */
export function restoreMentionCallback(spoken: Set<string>, botId: string, hop: number, sourceKey: string, sourceBotId?: string): void {
  const entry = mentionCallbacks.get(spoken);
  entry?.pending.set(JSON.stringify([botId, sourceKey]), { botId, hop, ...(sourceBotId ? { sourceBotId } : {}) });
}

/** True while a deferred delivery is still waiting to be dispatched. */
export function hasMentionCallbacks(spoken: Set<string>): boolean {
  return (mentionCallbacks.get(spoken)?.pending.size ?? 0) > 0;
}

/** Remove one delivery before dispatch so it cannot run twice. */
export function takeMentionCallback(spoken: Set<string>): { botId: string; hop: number; sourceBotId?: string } | null {
  const entry = mentionCallbacks.get(spoken);
  const next = entry?.pending.entries().next();
  if (!entry || !next || next.done) return null;
  const [key, delivery] = next.value;
  entry.pending.delete(key);
  return delivery;
}

/** Addressed reply lines, rather than names embedded in explanatory prose.
 * Accept the room's short handoff/result prefixes and exact display names. */
export function isAddressedRoomReply(text: string, name: string, roomNames: readonly string[] = [name]): boolean {
  const escapeName = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escaped = escapeName(name);
  const recipients = [...new Set(roomNames)].filter(Boolean).sort((a, b) => b.length - a.length).map(escapeName).join("|");
  // Only a contiguous leading list of exact room member names addresses
  // multiple recipients. Once ordinary prose starts, later mentions are inert.
  const leading = recipients ? `(?:@(?:${recipients})(?=[\\t ,]|$)[\\t ,]+)*` : "";
  return new RegExp(`^\\s*(?:(?:done|ready|blocked|approved|interface|claimed)\\s*[:,]?\\s+)?${leading}@${escaped}(?=$|[\\s:,.!?])`, "imu").test(text);
}
