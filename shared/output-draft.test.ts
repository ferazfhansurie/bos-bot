import { describe, expect, it } from "vitest";
import { validateOutputDraft, outputRevisionRequest, type OutputDraft } from "./output-draft";

const original = "hello hello";
const initial: OutputDraft = { revision: 0, versions: [original], comments: [] };
describe("human output working copies", () => {
  it("preserves original and all saved versions while appending edits", () => {
    const one = validateOutputDraft({ ...initial, versions: [original, "updated"] }, original);
    expect(one.revision).toBe(1);
    expect(initial.versions).toEqual([original]);
    expect(() => validateOutputDraft({ ...one, versions: ["changed", "updated"] }, original, one)).toThrow("overwritten");
    expect(() => validateOutputDraft({ ...one, versions: [original] }, original, one)).toThrow("overwritten");
  });
  it("rejects stale writers rather than losing saved edits", () => {
    const one = validateOutputDraft(initial, original);
    expect(() => validateOutputDraft(initial, original, one)).toThrow("changed elsewhere");
  });
  it("pins multiple comments to the exact occurrence and immutable saved version", () => {
    const draft = validateOutputDraft({ ...initial, versions: [original, "new wording"], comments: [
      { id: "a", version: 0, start: 6, end: 11, quote: "hello", text: "second occurrence" },
      { id: "b", version: 1, start: 4, end: 11, quote: "wording", text: "make this simpler" },
    ] }, original);
    const request = outputRevisionRequest("m1", draft, 1);
    expect(request).toContain("message m1");
    expect(request).toContain("version 1, characters 7–11");
    expect(request).toContain("version 2, characters 5–11");
    expect(request).toContain("<working-output>\nnew wording");
    expect(() => validateOutputDraft({ ...draft, comments: [{ ...draft.comments[0], quote: "other" }] }, original, draft)).toThrow("exact text");
  });
  it("rejects malformed and oversized content", () => {
    for (const versions of [[original, 8], [original, "x".repeat(100_001)], [original, ...Array(30).fill("")]]) {
      expect(() => validateOutputDraft({ ...initial, versions }, original)).toThrow();
    }
    for (const range of [{ start: -1, end: 2 }, { start: 1, end: 1 }, { start: 1, end: 20 }, { start: 0.5, end: 2 }]) {
      expect(() => validateOutputDraft({ ...initial, comments: [{ id: "x", version: 0, ...range, quote: "he", text: "change" }] }, original)).toThrow();
    }
  });
});
