/** In-flight stream text kept outside React state. Token frames notify
 * subscribers; each hook reads one slice and skips its re-render when that
 * slice is unchanged, so a busy room repaints only the bubble that grew. */
export interface StreamState {
  /** in-flight assistant text per threadId (room members: `${threadId}:room:${botId}`) */
  streaming: Record<string, string>;
  /** in-flight extended thinking per threadId (ephemeral) */
  reasoning: Record<string, string>;
}

export const EMPTY_STREAM: StreamState = { streaming: {}, reasoning: {} };

export interface StreamStore {
  get(): StreamState;
  set(update: (prev: StreamState) => StreamState): void;
  subscribe(listener: () => void): () => void;
}

export function createStreamStore(): StreamStore {
  let current = EMPTY_STREAM;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set(update) {
      const next = update(current);
      if (next === current) return;
      current = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Which room members have a live bubble, as a stable string: it changes
 * when a member starts or stops streaming, not on every token. */
export function roomStreamingMembers(state: StreamState, threadId: string): string {
  const prefix = `${threadId}:room:`;
  const ids: string[] = [];
  for (const [key, text] of Object.entries(state.streaming)) {
    if (text && key.startsWith(prefix)) ids.push(key.slice(prefix.length));
  }
  return ids.sort().join(",");
}
