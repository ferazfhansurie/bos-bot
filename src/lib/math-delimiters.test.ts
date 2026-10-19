import { describe, expect, it } from "vitest";
import { normalizeMathDelimiters } from "./math-delimiters";

describe("normalizeMathDelimiters", () => {
  it("rewrites inline and display backslash maths to dollars", () => {
    expect(normalizeMathDelimiters("area is \\(\\pi r^2\\) here")).toBe("area is $$\\pi r^2$$ here");
    expect(normalizeMathDelimiters("so\n\\[ E = mc^2 \\]\ndone")).toBe("so\n$$\nE = mc^2\n$$\ndone");
  });

  it("leaves code and escaped brackets in prose alone", () => {
    expect(normalizeMathDelimiters("`\\(x\\)` and\n```\n\\[y\\]\n```")).toBe("`\\(x\\)` and\n```\n\\[y\\]\n```");
    expect(normalizeMathDelimiters("see the \\[note\\] above")).toBe("see the \\[note\\] above");
  });
});
