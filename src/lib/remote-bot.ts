import type { Bot } from "@/state/store";

/** "on Putri's Mac" for a bot the server relays from a linked Mac; null for local bots. */
export function remoteBotHint(bot: Pick<Bot, "remote">): string | null {
  if (!bot.remote) return null;
  const place = `on ${bot.remote.ownerName?.trim() || bot.remote.homeName}'s Mac`;
  const status = bot.remote.availability === "update-required" ? "update required"
    : bot.remote.availability === "reconnect-required" ? "reconnect required"
    : bot.remote.online === false ? "offline" : null;
  return status ? `${status} · ${place}` : place;
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

/** Fixed UI copy, never a raw remote error or credential-bearing URL. */
export function remoteBotNotice(bot: Pick<Bot, "remote">): string | null {
  const remote = bot.remote;
  if (!remote) return null;
  const host = remote.ownerName?.trim() ? `${remote.ownerName.trim()}'s Mac` : remote.homeName;
  if (remote.availability === "update-required") return `Update BOS on ${host} before messaging this bot. Your chat history stays here.`;
  if (remote.availability === "reconnect-required") return `Reconnect ${host} in People & workspaces to message this bot.`;
  if (remote.online === false) return `${host} is unavailable. Keep BOS open there and check its connection. Your draft stays here.`;
  return null;
}
