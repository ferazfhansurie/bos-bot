import type { ActivityItem, ActivityState } from "../shared/activity.ts";
import type { RuntimeEvent } from "../shared/runtime-events.ts";

/** No transcript or provider payload is retained. Runtime facts are projected
 * only after the caller enumerates its authorized bot/thread pairs. */
export class ActivityFeed {
  private facts = new Map<string, { state: ActivityState; since: number; turnId?: string }>();
  private views = new Map<string, ActivityItem>();
  private now: () => number;
  constructor(now = Date.now) { this.now = now; }
  private key(botId: string, threadId: string) { return JSON.stringify([botId, threadId]); }
  stop(botId: string, threadId: string): void {
    const key = this.key(botId, threadId);
    const old = this.facts.get(key);
    this.facts.set(key, { state: "stopped", since: this.now(), ...(old?.turnId ? { turnId: old.turnId } : {}) });
  }
  observe(botId: string, threadId: string, event: RuntimeEvent): void {
    const key = this.key(botId, threadId);
    const old = this.facts.get(key);
    // A late terminal/item from an old turn cannot replace a newer one.
    if (event.type !== "turn.started" && event.turnId && old?.turnId && event.turnId !== old.turnId) return;
    if (old?.state === "stopped" && event.type !== "turn.started") return;
    let state: ActivityState | undefined;
    if (event.type === "turn.started" || event.type === "turn.retrying" || event.type === "request.resolved") state = "thinking";
    else if (event.type === "request.opened") state = "waiting";
    else if (event.type === "item.started" || event.type === "item.updated") state = event.itemType === "tool" ? "tool" : "thinking";
    else if (event.type === "content.delta") state = event.streamKind === "assistant_text" ? "typing" : "thinking";
    else if (event.type === "item.completed") state = event.itemType === "assistant_text" ? "typing" : "thinking";
    else if (event.type === "turn.completed") state = event.ok ? "idle" : /interrupt|cancel|stop/i.test(event.stopReason ?? "") ? "stopped" : "failed";
    if (!state) return;
    const newTurn = event.type === "turn.started" && event.turnId !== old?.turnId;
    this.facts.set(key, { state, since: old?.state === state && !newTurn ? old.since : this.now(),
      ...(event.turnId ? { turnId: event.turnId } : !newTurn && old?.turnId ? { turnId: old.turnId } : {}) });
  }
  project(pair: { botId: string; threadId: string; roomId: string | null; running: boolean; waiting: boolean; held: boolean }): ActivityItem {
    const key = this.key(pair.botId, pair.threadId);
    const fact = this.facts.get(key);
    const state: ActivityState = (pair.held || fact?.state === "stopped") ? "stopped" : pair.waiting ? "waiting" : pair.running
      ? fact && ["thinking", "tool", "typing", "waiting"].includes(fact.state) ? fact.state : "thinking"
      : fact && ["failed", "stopped"].includes(fact.state) ? fact.state : "idle";
    // Preserve timestamps across reads. Terminal provider identity is omitted.
    const view = this.views.get(key);
    const next = { state, since: view?.state === state ? view.since : fact?.state === state ? fact.since : this.now(), ...(pair.running && fact?.turnId ? { turnId: fact.turnId } : {}) };
    const item = { botId: pair.botId, threadId: pair.threadId, roomId: pair.roomId, ...next };
    this.views.set(key, item);
    return item;
  }
}
