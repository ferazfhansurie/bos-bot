import { describe, expect, it } from "vitest";
import { compareSequence, isSequence, maxSequence } from "./sequence";

describe("cloud sequences", () => {
  it("compares decimal strings past the safe integer range", () => {
    expect(compareSequence("9007199254740993", "9007199254740992")).toBe(1);
    expect(compareSequence("10", "9")).toBe(1);
    expect(compareSequence("42", "42")).toBe(0);
    expect(maxSequence(null, "3")).toBe("3");
  });

  it("rejects non-canonical sequence strings", () => {
    expect(isSequence("01")).toBe(false);
    expect(isSequence("-1")).toBe(false);
    expect(isSequence(5)).toBe(false);
    expect(isSequence("0")).toBe(true);
  });
});
