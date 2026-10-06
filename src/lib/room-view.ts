import type { GroupDefaultResponder } from "@/state/store";
import { remoteBotHint, remoteBotUnavailable } from "@/lib/remote-bot";
import type { RemoteBotOrigin } from "../../shared/wire";

export interface RoomViewFields {
  avatarUrl?: string | null;
  memberReplyModes?: Record<string, "always" | "mentions">;
  notifications?: "all" | "mentions" | "muted";
  activeBotIds?: string[];
}

export function roomMemberReplyMode(room: RoomViewFields & { defaultResponder: GroupDefaultResponder }, botId: string): "always" | "mentions" {
  const override = room.memberReplyModes?.[botId];
  if (override) return override;
  return room.defaultResponder?.kind === "everyone" || (room.defaultResponder?.kind === "member" && room.defaultResponder.botId === botId) ? "always" : "mentions";
}

export function roomMemberStatus(room: Pick<RoomViewFields, "activeBotIds"> & { busyBotId?: string | null }, bot: { id: string; remote?: { online?: boolean; availability?: string } }): "working" | "idle" | "offline" {
  if (remoteBotUnavailable(bot)) return "offline";
  if (room.activeBotIds?.includes(bot.id) || room.busyBotId === bot.id) return "working";
  return "idle";
}

/** A member's status line in room UI: "working", or for a bot relayed from a
 * linked Mac, where it runs ("idle · on Putri's Mac", "offline · on …"). */
export function roomMemberStatusLabel(status: "working" | "idle" | "offline", bot: { remote?: RemoteBotOrigin }): string {
  const hint = remoteBotHint(bot);
  if (!hint) return status;
  // The hint already leads with the offline reason.
  return status === "offline" ? hint : `${status} · ${hint}`;
}

// Header roster for big rooms: working bots first, then the rest in room
// order, offline last; only the first `max` are drawn and the rest become a
// "+n" count, so 20 bots never push the header controls off screen.
export function roomRosterPreview<T>(members: T[], statusOf: (member: T) => "working" | "idle" | "offline", max = 5): { visible: T[]; rest: T[] } {
  const rank = { working: 0, idle: 1, offline: 2 } as const;
  const ordered = members.map((member, index) => ({ member, index, rank: rank[statusOf(member)] }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ member }) => member);
  // Never trade one avatar for a "+1" pill that takes the same room.
  const cap = ordered.length > max ? Math.max(1, max - 1) : ordered.length;
  return { visible: ordered.slice(0, cap), rest: ordered.slice(cap) };
}

export function shouldCollapseRoomReply(message: { role: string; kind: string; text?: string | null }): boolean {
  return message.role === "bot" && message.kind === "text" && Boolean(message.text && (message.text.length > 600 || message.text.split("\n").length > 6));
}

type RunMessage = { role: string; kind?: string; at: number; comm?: unknown; from?: { botId?: string } | null; sender?: { id?: string } | null };

/** Consecutive text bubbles from one sender on one day form a run: the name
 * shows on the first, the avatar on the last, and they sit 4px apart. */
export function sameBubbleRun(a: RunMessage | undefined, b: RunMessage | undefined): boolean {
  if (!a || !b || a.kind !== "text" || b.kind !== "text" || a.comm || b.comm) return false;
  if (a.role !== b.role || a.from?.botId !== b.from?.botId || a.sender?.id !== b.sender?.id) return false;
  return new Date(a.at).toDateString() === new Date(b.at).toDateString();
}
