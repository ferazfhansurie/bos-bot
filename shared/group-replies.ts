import type { SharedTextMessage } from "./multiplayer.js";

export type GroupReplyMode = "follow" | "fixed" | "mentions";
export interface GroupReplyPreference { replyMode?: GroupReplyMode; replyBotId?: string | null }

/** Resolve only against the current authorized roster. Remembered routing is
 * derived from durable sends, per human, so retries cannot change the speaker. */
export function groupReplyTargets(input: {
  actorId: string; preference: GroupReplyPreference; available: string[];
  explicitBots: string[]; humanMentions: string[]; history: readonly SharedTextMessage[];
}): string[] {
  const allowed = new Set(input.available);
  if (input.explicitBots.length) return input.explicitBots.filter(id => allowed.has(id));
  if (input.humanMentions.length) return [];
  const mode = input.preference.replyMode ?? "follow";
  if (mode === "mentions") return [];
  if (mode === "fixed") return input.preference.replyBotId && allowed.has(input.preference.replyBotId) ? [input.preference.replyBotId] : [];
  for (let i = input.history.length - 1; i >= 0; i--) {
    const message = input.history[i]!;
    if (`${message.actor.homeId}:${message.actor.kind}:${message.actor.localId}` !== input.actorId || message.actor.kind !== "person") continue;
    if (message.botTargets?.length) return message.botTargets.filter(id => allowed.has(id));
    if (message.humanMentions?.length) return [];
  }
  return [];
}
