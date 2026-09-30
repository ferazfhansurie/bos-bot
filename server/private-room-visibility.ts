/** The same current-data predicate gates room reads and push recipients. */
export function privateRoomForViewer(input: {
  viewerId: string | null | undefined;
  ownerId: string;
  peerSession: boolean;
  memberIds: string[];
  privateBotIds: Set<string>;
  messages: Array<{ actorId: string; botTargets?: string[] }>;
}): boolean {
  if (!input.peerSession && input.viewerId === input.ownerId) return false;
  return input.memberIds.some(id => input.privateBotIds.has(id)) ||
    input.messages.some(message => input.privateBotIds.has(message.actorId) ||
      message.botTargets?.some(id => input.privateBotIds.has(id)) === true);
}
