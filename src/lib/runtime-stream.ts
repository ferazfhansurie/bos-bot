/** Public room task remains canonical; ephemeral buffers belong to one member. */
export function runtimeStreamKey(event: { threadId: string; roomBotId?: string }): string {
  return event.roomBotId ? roomMemberStreamKey(event.threadId, event.roomBotId) : event.threadId;
}
export function roomMemberStreamKey(threadId: string, botId: string): string {
  return `${threadId}:room:${botId}`;
}
