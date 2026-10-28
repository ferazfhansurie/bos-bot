import { describe, expect, it } from "vitest";
import type { Message } from "@/state/store";
import { doneTrail, lastNewsAt, steerReads, turnSteps } from "./thread-worker";

let n = 0;
const user = (extra: Partial<Message> = {}): Message => ({ id: `u${++n}`, role: "user", kind: "text", text: "hi", at: n, ...extra } as Message);
const bot = (): Message => ({ id: `b${++n}`, role: "bot", kind: "text", text: "ok", at: n } as Message);
const tool = (ok?: boolean, extra: Partial<Message> = {}): Message =>
  ({ id: `t${++n}`, role: "bot", kind: "activity", tool: { name: "Read", ok }, at: n, ...extra } as Message);

describe("turnSteps", () => {
  it("counts tools after the message that started the turn, across mid-turn sends", () => {
    const messages = [user(), tool(true), bot(), user(), tool(true), user({ steered: true }), tool()];
    expect(turnSteps(messages).map((m) => m.id)).toEqual([messages[4]!.id, messages[6]!.id]);
  });
  it("leaves out bot chips and failed-turn rows", () => {
    const messages = [user(), tool(true, { comm: { direction: "out" } } as unknown as Partial<Message>), tool(false, { tool: { name: "error: boom", ok: false } } as Partial<Message>), tool(true)];
    expect(turnSteps(messages)).toHaveLength(1);
  });
});

describe("doneTrail", () => {
  it("keeps the last three finished steps, oldest first", () => {
    const steps = [tool(true), tool(true), tool(false), tool(true), tool()];
    expect(doneTrail(steps).map((m) => m.id)).toEqual(steps.slice(1, 4).map((m) => m.id));
  });
});

describe("steerReads", () => {
  it("waits until something new lands after the send", () => {
    const steer = user({ steered: true });
    expect(steerReads([user(), tool(), steer], true).get(steer.id)).toBe("waiting");
    expect(steerReads([user(), tool(), steer, tool()], true).get(steer.id)).toBe("read");
  });
  it("counts a finished turn as read and skips unknown deliveries", () => {
    const steer = user({ steered: true });
    const unknown = user({ steered: true, steerDelivery: "outcome_unknown" });
    const reads = steerReads([user(), steer, unknown], false);
    expect(reads.get(steer.id)).toBe("read");
    expect(reads.has(unknown.id)).toBe(false);
  });
  it("ignores plain sends", () => {
    expect(steerReads([user(), bot()], true).size).toBe(0);
  });
});

describe("lastNewsAt", () => {
  it("is the newest row or the turn start", () => {
    expect(lastNewsAt([user()], null)).toBeNull();
    expect(lastNewsAt([{ ...user(), at: 50 }], 100)).toBe(100);
    expect(lastNewsAt([{ ...user(), at: 150 }], 100)).toBe(150);
  });
});
