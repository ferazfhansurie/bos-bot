/** Which room messages arrived while the room was open, so only those
 * spring in. Whatever was on screen when the room opened, and older pages
 * loaded above it, stay still. An arrival keeps its class for `windowMs`, long
 * enough for the entrance to finish across re-renders, then drops it. */
export interface ArrivalState {
  threadId: string;
  /** Newest message time when the room opened; earlier pages never animate. */
  baseline: number;
  known: Set<string>;
  arrivedAt: Map<string, number>;
}

export const ARRIVAL_WINDOW_MS = 400;

export function trackArrivals(
  state: ArrivalState | null,
  threadId: string,
  messages: readonly { id: string; at: number }[],
  now: number,
): ArrivalState {
  if (!state || state.threadId !== threadId) {
    return {
      threadId,
      baseline: messages.reduce((latest, message) => Math.max(latest, message.at), -Infinity),
      known: new Set(messages.map((message) => message.id)),
      arrivedAt: new Map(),
    };
  }
  for (const message of messages) {
    if (state.known.has(message.id)) continue;
    state.known.add(message.id);
    if (message.at >= state.baseline) state.arrivedAt.set(message.id, now);
  }
  for (const [id, at] of state.arrivedAt) if (now - at >= ARRIVAL_WINDOW_MS) state.arrivedAt.delete(id);
  return state;
}

export function isArriving(state: ArrivalState | null, id: string): boolean {
  return state?.arrivedAt.has(id) ?? false;
}
