import { describe, expect, it } from "vitest";
import type { CheckinsSnapshot } from "../../shared/checkins";
import { clearedShare, greetingFor, nextCheckinAt, openItems } from "./checkins";
import { checkinButtons } from "@/components/CheckinBrief";

const snap = (patch: Partial<CheckinsSnapshot> = {}): CheckinsSnapshot => ({
  items: [], counts: { later: 0, done: 0, no: 0 }, setUp: true, slots: ["morning", "afternoon", "night"], ...patch,
});
const at = (hour: number, minute = 0) => new Date(2026, 9, 27, hour, minute).getTime();

describe("check-ins on the client", () => {
  it("rings the share of today already cleared", () => {
    expect(clearedShare(null)).toBe(0);
    expect(clearedShare(snap())).toBe(0);
    const item = { id: "a" } as CheckinsSnapshot["items"][number];
    expect(clearedShare(snap({ items: [item], counts: { later: 2, done: 2, no: 1 } }))).toBeCloseTo(0.75);
    expect(openItems(snap({ items: [item] }))).toHaveLength(1);
  });

  it("finds the next look across the day and into tomorrow", () => {
    expect(nextCheckinAt(snap({ setUp: false }), at(8))).toBeNull();
    expect(nextCheckinAt(snap(), at(8))).toBe(at(9));
    expect(nextCheckinAt(snap(), at(9))).toBe(at(14));
    expect(nextCheckinAt(snap(), at(15))).toBe(at(22));
    expect(nextCheckinAt(snap(), at(23))).toBe(new Date(2026, 9, 28, 9).getTime());
    expect(nextCheckinAt(snap({ slots: ["night"] }), at(10))).toBe(at(22));
  });

  it("greets by the hour", () => {
    expect(greetingFor(at(7))).toBe("morning");
    expect(greetingFor(at(13))).toBe("afternoon");
    expect(greetingFor(at(21))).toBe("evening");
  });

  it("offers go ahead first, and only an ack for a report", () => {
    expect(checkinButtons({ kind: "decide" }).map((b) => b.action)).toEqual(["approve", "done", "not-now", "no"]);
    expect(checkinButtons({ kind: "decide", draft: "hi" })[0]!.label).toBe("v3.today.send");
    expect(checkinButtons({ kind: "broke" })[0]!.label).toBe("v3.today.fixIt");
    expect(checkinButtons({ kind: "did" }).map((b) => b.action)).toEqual(["done", "no"]);
  });
});
