import type { GroupDefaultResponder } from "@/state/store";

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
  if (bot.remote?.online === false || (bot.remote?.availability && bot.remote.availability !== "ready")) return "offline";
  if (room.activeBotIds?.includes(bot.id) || room.busyBotId === bot.id) return "working";
  return "idle";
}

export function shouldCollapseRoomReply(message: { role: string; kind: string; text?: string | null }): boolean {
  return message.role === "bot" && message.kind === "text" && Boolean(message.text && (message.text.length > 600 || message.text.split("\n").length > 6));
}
