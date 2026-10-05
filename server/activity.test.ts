import { expect, it } from "vitest";
import { ActivityFeed } from "./activity.ts";
import type { RuntimeEvent } from "../shared/runtime-events.ts";

it("tracks turn phases, timestamps and isolation across bot/thread lanes", () => {
  let now = 100;
  const feed = new ActivityFeed(() => now);
  const event = (data: object) => ({ eventId: "e", provider: "fake", threadId: "t", createdAt: "", turnId: "one", ...data }) as RuntimeEvent;
  const read = (botId = "b", threadId = "t", running = true, waiting = false, held = false) => feed.project({ botId, threadId, roomId: null, running, waiting, held });
  feed.observe("b", "t", event({ type: "turn.started" }));
  expect(read()).toMatchObject({ state: "thinking", since: 100, turnId: "one" });
  now = 200;
  feed.observe("b", "t", event({ type: "item.started", itemType: "tool" }));
  expect(read()).toMatchObject({ state: "tool", since: 200 });
  now = 300;
  expect(read()).toMatchObject({ state: "tool", since: 200 });
  expect(read("other", "t", false).state).toBe("idle");
  expect(read("b", "other", false).state).toBe("idle");
  feed.observe("b", "t", event({ type: "request.opened" }));
  expect(read().state).toBe("waiting");
  feed.observe("b", "t", event({ type: "request.resolved" }));
  expect(read().state).toBe("thinking");
  feed.observe("b", "t", event({ type: "content.delta", streamKind: "assistant_text", delta: "private" }));
  expect(read().state).toBe("typing");
  expect(JSON.stringify(read())).not.toContain("private");
  feed.observe("b", "t", event({ type: "turn.completed", ok: false, stopReason: "failure" }));
  expect(read("b", "t", false)).toMatchObject({ state: "failed" });
  expect(read("b", "t", false).turnId).toBeUndefined();
  feed.observe("b", "t", event({ type: "turn.started", turnId: "two" }));
  feed.observe("b", "t", event({ type: "turn.completed", ok: false }));
  expect(read()).toMatchObject({ state: "thinking", turnId: "two" });
  feed.stop("b", "t");
  expect(read("b", "t", true, false, true).state).toBe("stopped");
  feed.observe("b", "t", event({ type: "turn.completed", turnId: "two", ok: true }));
  expect(read("b", "t", false, false, true).state).toBe("stopped");
  // A later turn in a still-held thread (hold kept across Stop or a restart) is live.
  feed.observe("b", "t", event({ type: "turn.started", turnId: "three" }));
  expect(read("b", "t", true, false, true)).toMatchObject({ state: "thinking", turnId: "three" });
  feed.observe("b", "t", event({ type: "item.started", turnId: "three", itemType: "tool" }));
  expect(read("b", "t", true, false, true).state).toBe("tool");
  // Held with no turn seen since the restart still reads stopped.
  expect(read("b", "fresh", true, false, true).state).toBe("stopped");
  feed.observe("b", "t", event({ type: "turn.completed", turnId: "three", ok: true }));
  expect(read("b", "t", false).state).toBe("idle");
});
