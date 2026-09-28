/** Fail-closed projection for the dedicated peer stream. No global replay
 * buffer is used: reconnects hydrate authorized durable transcripts. */
export interface PeerEventAccess {
  owns(threadId: string): boolean;
  botView(botId: string): Record<string, unknown> | null;
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
export function peerEvent(frame: Record<string, unknown>, access: PeerEventAccess): Record<string, unknown> | null {
  if (frame.kind === "bot") {
    if (!object(frame.bot) || typeof frame.bot.id !== "string") return null;
    const bot = access.botView(frame.bot.id);
    return bot ? { kind: "bot", bot } : null;
  }
  if (frame.kind === "runtime") {
    if (!object(frame.event) || typeof frame.event.threadId !== "string" || !access.owns(frame.event.threadId)) return null;
    const { raw: _raw, ...event } = frame.event;
    return { kind: "runtime", event };
  }
  if (typeof frame.threadId !== "string" || !access.owns(frame.threadId)) return null;
  if (frame.kind === "thread" && typeof frame.activeLeafId === "string") {
    return { kind: "thread", threadId: frame.threadId, activeLeafId: frame.activeLeafId };
  }
  if ((frame.kind === "message" || frame.kind === "message.patch") && object(frame.message)) {
    const { comm: _comm, roomRequest: _roomRequest, ...message } = frame.message;
    if (object(message.threadRef) && (typeof message.threadRef.threadId !== "string" || !access.owns(message.threadRef.threadId))) delete message.threadRef;
    return { kind: frame.kind, threadId: frame.threadId, message };
  }
  return null;
}
