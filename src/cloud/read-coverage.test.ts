import { describe, expect, it } from "vitest";
import type { ReadCoverage } from "../../shared/cloud-protocol/index";
import { EMPTY_COVERAGE, isRead, markReadThrough, markViewed, unreadCount } from "./read-coverage";

describe("cloud read coverage", () => {
  it("grows the prefix from the start of a thread", () => {
    const { coverage, post } = markViewed(EMPTY_COVERAGE, { sequences: ["2", "5", "9"], after: null }, new Set(["2", "5"]));
    expect(coverage.prefix).toBe("5");
    expect(post).toEqual([["0", "5"]]);
    expect(coverage.intervals).toEqual([]);
    expect(isRead(coverage, "9")).toBe(false);
  });

  it("keeps a sparse interval when the gap before it was never loaded", () => {
    const { coverage } = markViewed(EMPTY_COVERAGE, { sequences: ["40", "41", "45"] }, new Set(["41", "45"]));
    expect(coverage.prefix).toBe("0");
    expect(coverage.intervals).toEqual([["41", "45"]]);
    expect(isRead(coverage, "40")).toBe(false);
  });

  it("bridges an interval into the prefix only once the gap is viewed", () => {
    let coverage: ReadCoverage = markViewed(EMPTY_COVERAGE, { sequences: ["1", "2"], after: null }, new Set(["1", "2"])).coverage;
    coverage = markViewed(coverage, { sequences: ["7", "8"] }, new Set(["7", "8"])).coverage;
    expect(coverage).toMatchObject({ prefix: "2", intervals: [["7", "8"]] });
    coverage = markViewed(coverage, { sequences: ["3", "7"], after: "2" }, new Set()).coverage;
    expect(coverage).toMatchObject({ prefix: "2", intervals: [["7", "8"]] });
    const bridged = markViewed(coverage, { sequences: ["3", "7"], after: "2" }, new Set(["3"]));
    expect(bridged.coverage).toMatchObject({ prefix: "8", intervals: [] });
    expect(bridged.post).toEqual([["2", "7"]]);
  });

  it("stops at 256 intervals with read_coverage_limit and keeps the old state", () => {
    let coverage: ReadCoverage = EMPTY_COVERAGE;
    for (let index = 0; index < 256; index += 1) {
      const sequence = String(10 + index * 10);
      coverage = markViewed(coverage, { sequences: [sequence] }, new Set([sequence])).coverage;
    }
    expect(coverage.intervals).toHaveLength(256);
    const result = markViewed(coverage, { sequences: ["5000"] }, new Set(["5000"]));
    expect(result.status).toBe("read_coverage_limit");
    expect(result.coverage).toBe(coverage);
    expect(result.post).toEqual([]);
    expect(isRead(result.coverage, "5000")).toBe(false);
    const marked = markReadThrough(result.coverage, "5000");
    expect(marked).toMatchObject({ prefix: "5000", intervals: [] });
    expect(isRead(marked, "5001")).toBe(false);
  });

  it("counts only other people's final, undeleted messages", () => {
    const messages = [
      { sequence: "1", actor_id: "me" },
      { sequence: "2", actor_id: "ana" },
      { sequence: "3", actor_id: "bot", provisional: true },
      { sequence: "4", actor_id: "bot" },
      { sequence: "5", actor_id: "ana", deleted: true },
      { sequence: "4", actor_id: "bot" },
    ];
    expect(unreadCount(EMPTY_COVERAGE, messages, "me")).toBe(2);
    expect(unreadCount({ prefix: "2", intervals: [], attention: false }, messages, "me")).toBe(1);
  });
});
