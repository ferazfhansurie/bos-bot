import type { Bot } from "@/state/store";

/** "on Putri's Mac" for a bot the server relays from a linked Mac; null for local bots. */
export function remoteBotHint(bot: Pick<Bot, "remote">): string | null {
  if (!bot.remote) return null;
  const place = `on ${bot.remote.ownerName?.trim() || bot.remote.homeName}'s Mac`;
  return bot.remote.online === false ? `offline · ${place}` : place;
}

/**
 * Controls a relayed bot's own Mac keeps: its settings, computer, inspector,
 * folders, queue steering, remembered grants ("always allow" is refused by the
 * relay) and voice setup all live there. @mentions route through ask_bot on
 * this Mac, which cannot reach a relayed bot. Edit and version switching are
 * proxied, so they are not listed and stay available.
 */
const LOCAL_ONLY_CONTROLS = new Set([
  "settings",
  "computer",
  "inspector",
  "folders",
  "steer",
  "alwaysAllow",
  "voiceSetup",
  "mention",
] as const);

export type LocalOnlyBotControl = typeof LOCAL_ONLY_CONTROLS extends Set<infer C> ? C : never;
export type BotControl = LocalOnlyBotControl | "edit" | "versions";

/** Whether `control` may be offered for this bot. Local (or absent) bots get everything. */
export function botControlAvailable(bot: Pick<Bot, "remote"> | null | undefined, control: BotControl): boolean {
  if (!bot?.remote) return true;
  return !LOCAL_ONLY_CONTROLS.has(control as LocalOnlyBotControl);
}

/** Bots the 1:1 composer offers for @mention: visible, local, and not the bot being talked to. */
export function mentionableBots<T extends Pick<Bot, "id" | "hidden" | "remote">>(bots: readonly T[], selfId?: string): T[] {
  return bots.filter((candidate) => candidate.id !== selfId && !candidate.hidden && botControlAvailable(candidate, "mention"));
}
