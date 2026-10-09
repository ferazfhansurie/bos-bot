import { MAUS_COLOR_NAMES, type MausColor } from "@/lib/mascot";
import type { Bot, Group } from "@/state/store";
import { mascotBodySchema } from "../../shared/mascot-bodies";
import type { RemoteBotOrigin, RemoteRoomBot } from "../../shared/wire";

// Turning a set of ticked bots back into a room's ordered roster. Existing
// members keep their order, so the room's lead does not move when someone new
// joins; additions land at the end, in the order the picker listed them.
export function nextMemberIds(current: string[], picked: Set<string>, order: string[]): string[] {
  return [...current.filter((id) => picked.has(id)), ...order.filter((id) => picked.has(id) && !current.includes(id))];
}

const COLORS = new Set<string>(MAUS_COLOR_NAMES);

/** A bot from another home's room as a display-only Bot. Every field comes
 * off the wire, so each is checked; BotAvatar re-validates the image. */
export function remoteRoomBot(bot: RemoteRoomBot, home: { id: string; name: string }): Bot {
  const avatarUrl = typeof bot.avatarUrl === "string" ? bot.avatarUrl : undefined;
  const avatarCrop = typeof bot.avatarCrop === "string" ? (bot.avatarCrop as Bot["avatarCrop"]) : undefined;
  return {
    id: bot.id,
    // No thread on this home: nothing may find or open this bot by thread.
    threadId: "",
    name: typeof bot.name === "string" && bot.name.trim() ? bot.name : "Bot",
    title: typeof bot.title === "string" ? bot.title : "",
    description: "",
    notifications: false,
    color: COLORS.has(bot.color) || /^#[0-9A-Fa-f]{6}$/.test(bot.color) ? (bot.color as MausColor) : "gray",
    mascotBody: mascotBodySchema.safeParse(bot.mascotBody).data ?? null,
    ...(avatarUrl ? { avatarUrl } : {}),
    ...(avatarCrop ? { avatarCrop } : {}),
    unread: false,
    modelSelection: { instanceId: "", model: "" },
    messages: [],
    roomHome: { id: home.id, name: home.name },
  };
}

function isRemoteRoomBot(value: unknown): value is RemoteRoomBot {
  return Boolean(value) && typeof value === "object" && typeof (value as { id?: unknown }).id === "string";
}

/**
 * The room's member bots, in roster order. A room on this home looks its
 * members up among this home's bots. A room on another home names that
 * home's bots, so they come from `group.memberBots`; a server that predates
 * the field leaves the old local lookup in place.
 */
export function roomMemberBots(group: Pick<Group, "memberIds" | "home" | "memberBots">, bots: readonly Bot[]): Bot[] {
  const home = group.home;
  if (home && Array.isArray(group.memberBots)) {
    const listed = group.memberBots.filter(isRemoteRoomBot);
    const byId = new Map(listed.map((bot) => [bot.id, bot]));
    const ordered = group.memberIds?.length
      ? group.memberIds.flatMap((id) => {
          const bot = byId.get(id);
          return bot ? [bot] : [];
        })
      : listed;
    return ordered.map((bot) => remoteRoomBot(bot, home));
  }
  // A member relayed from a linked Mac (`rb-…`) is normally in `bots`; while
  // the bridge has dropped it, the room's own display record keeps it drawn.
  const listed = Array.isArray(group.memberBots) ? group.memberBots.filter(isRemoteRoomBot) : [];
  return (group.memberIds ?? []).flatMap((id) => {
    const bot = bots.find((candidate) => candidate.id === id);
    if (bot) return [bot];
    const entry = id.startsWith("rb-") ? listed.find((candidate) => candidate.id === id) : undefined;
    const remote = entry ? remoteOrigin((entry as { remote?: unknown }).remote) : null;
    return entry && remote ? [relayedRoomBot(entry, remote)] : [];
  });
}

function remoteOrigin(value: unknown): RemoteBotOrigin | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.homeId !== "string" || typeof raw.homeName !== "string") return null;
  const availability = ["ready", "offline", "update-required", "reconnect-required"].includes(raw.availability as string)
    ? (raw.availability as RemoteBotOrigin["availability"])
    : undefined;
  return {
    homeId: raw.homeId,
    homeName: raw.homeName,
    ownerName: typeof raw.ownerName === "string" ? raw.ownerName : null,
    ...(typeof raw.online === "boolean" ? { online: raw.online } : {}),
    ...(availability ? { availability } : {}),
  };
}

/** A relayed member this client has no bot record for: display-only, like a
 * guest bot, but marked `remote` (not `roomHome`) since the room is ours. */
function relayedRoomBot(entry: RemoteRoomBot, remote: RemoteBotOrigin): Bot {
  const { roomHome: _roomHome, ...bot } = remoteRoomBot(entry, { id: remote.homeId, name: remote.homeName });
  return { ...bot, remote };
}

/** Bots a room on this home may offer in its member picker: visible bots —
 * local or relayed from a linked Mac — plus any hidden bot already in the
 * room, so a member can always be removed. */
export function roomCandidateBots<T extends Pick<Bot, "id" | "hidden" | "roomHome">>(bots: readonly T[], memberIds: readonly string[] = []): T[] {
  return bots.filter((bot) => !bot.roomHome && (!bot.hidden || memberIds.includes(bot.id)));
}

/** True for a member seen only through a room on another home. */
export function isRoomGuestBot(bot: Pick<Bot, "roomHome"> | undefined): boolean {
  return Boolean(bot?.roomHome);
}

/** Remote providers are checked by their own home. Display-only room bots
 * deliberately have no local instance id; that cannot turn an image into a Finder path. */
export function roomBotSupportsImages(bot: Pick<Bot, "remote" | "roomHome" | "modelSelection"> | undefined,
  instances: readonly { instanceId: string; capabilities?: { images?: boolean } }[]): boolean {
  return Boolean(bot && (bot.remote || bot.roomHome || instances.find(instance => instance.instanceId === bot.modelSelection.instanceId)?.capabilities?.images));
}

/** The members that are this home's own bots — the only ones local bot
 * routes, DMs, settings and calls may use. */
export function localRoomMembers(members: readonly Bot[]): Bot[] {
  // A display-only stand-in (no thread on this home) is never drivable here.
  return members.filter((member) => !member.roomHome && member.threadId !== "");
}

/** The @ picker's room choices: @everyone (not in a bot⇄bot channel), then
 * the members in roster order — another home's bots included. */
export function roomMentionPool(group: Pick<Group, "dm">, members: readonly Bot[]): Array<{ id: string; name: string; bot?: Bot }> {
  return [
    ...(!group.dm ? [{ id: "__everyone__", name: "everyone" }] : []),
    ...members.map((member) => ({ id: member.id, name: member.name, bot: member })),
  ];
}
