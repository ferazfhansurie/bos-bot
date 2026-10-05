import type { WireGroup } from "../shared/wire.ts";

/** Project only claimed live owners; never infer ownership from messages or
 * persisted busy flags. Facts belong to the speaker object, not its reused lane. */
export function publicRoomMemberTurns(
  speakers: ReadonlyArray<readonly [string, { botId: string }]>,
  canonicalThreadId: (runtimeId: string) => string,
  facts: WeakMap<object, { startedAt: number; turnId?: string }>,
): NonNullable<WireGroup["activeMemberTurns"]> {
  return speakers.map(([runtimeId, speaker]) => {
    const turn = facts.get(speaker);
    return {
      botId: speaker.botId,
      threadId: canonicalThreadId(runtimeId),
      startedAt: turn?.startedAt ?? null,
      ...(turn?.turnId ? { turnId: turn.turnId } : {}),
    };
  });
}
