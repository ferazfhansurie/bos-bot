import type { Message } from "@/state/store";

/** The newest user message, when it is words the running turn took in
 * (a definite steer). An earlier user message ends the search: anything
 * older was answered already. */
export function lastSteeredId(messages: readonly Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (message.role !== "user") continue;
    return message.steered === true ? message.id : undefined;
  }
  return undefined;
}

/** Every steered id one thread has shown, so an id that drops out and comes
 * back (a queued send sits after it for a moment, then moves to the queue)
 * is never taken for a new one. */
export type SteerSeen = { scope: string; ids: Set<string> };

/** Whether a steered id is new to the person watching: the same thread,
 * the island up, and an id this thread never showed. Switching threads
 * or bringing the island up never counts as a steer landing. */
export function steerAckFresh(seen: SteerSeen, scope: string, active: boolean, id: string | undefined): boolean {
  return active && Boolean(id) && seen.scope === scope && !seen.ids.has(id!);
}

/** The seen set after this render: a new thread starts over. */
export function noteSteer(seen: SteerSeen, scope: string, id: string | undefined): SteerSeen {
  const ids = seen.scope === scope ? seen.ids : new Set<string>();
  if (id) ids.add(id);
  return { scope, ids };
}
