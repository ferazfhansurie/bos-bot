// What the mac's notch and menu bar clock show for a busy thread: the same
// plain-words step, plan progress and one job clock the phone's live card
// gets from live-activity-driver.ts, folded onto the activity snapshot.
// Fields are optional, so an older renderer simply ignores them.
import type { ActivityItem } from "../shared/activity.ts";
import { liveStep } from "./live-step.ts";

const BUSY = new Set(["thinking", "tool", "typing", "waiting"]);

type Tail = (threadId: string) => Parameters<typeof liveStep>[0];

export class LiveFeed {
  /** `${botId}:${threadId}` → when that job began, while it stays busy. */
  private jobs = new Map<string, number>();
  /** The last real step each job showed, so a bare state never replaces it. */
  private steps = new Map<string, Pick<ActivityItem, "step" | "stepIndex" | "stepCount">>();

  enrich(items: readonly ActivityItem[], tail: Tail, now = Date.now()): ActivityItem[] {
    const busy = new Set<string>();
    const out = items.map(item => {
      if (!BUSY.has(item.state)) return item;
      const key = `${item.botId}:${item.threadId}`;
      busy.add(key);
      const jobSince = Math.min(this.jobs.get(key) ?? now, item.since || now);
      this.jobs.set(key, jobSince);
      let found: ReturnType<typeof liveStep>;
      try { found = liveStep(tail(item.threadId), jobSince); } catch { found = undefined; }
      if (found) this.steps.set(key, { step: found.line,
        ...(found.stepCount ? { stepIndex: found.stepIndex, stepCount: found.stepCount } : {}) });
      return { ...item, jobSince, ...this.steps.get(key) };
    });
    for (const key of this.jobs.keys()) if (!busy.has(key)) { this.jobs.delete(key); this.steps.delete(key); }
    return out;
  }

  /** The same fields from the last `enrich`, without moving any clock: for
   * a narrower snapshot (one viewer's scope) read between pushes. */
  peek(items: readonly ActivityItem[]): ActivityItem[] {
    return items.map(item => {
      const key = `${item.botId}:${item.threadId}`;
      const jobSince = BUSY.has(item.state) ? this.jobs.get(key) : undefined;
      return jobSince === undefined ? item : { ...item, jobSince, ...this.steps.get(key) };
    });
  }
}
