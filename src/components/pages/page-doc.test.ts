import { describe, expect, it } from "vitest";
import { blocksToDoc, docToBlocks } from "./page-doc";
import { markdownToBlocks, blocksToMarkdown, mergeBlocks } from "../../../shared/page";
describe("page editor conversion", () => {
  it("retains block ids and formatting across nested lists, tables, callouts and code", () => {
    const blocks = markdownToBlocks("# Heading\n\n**bold** and [link](https://example.com)\n\n- first\n  - nested\n- [x] task\n\n> quote\n\n> [!TIP] callout\n\n```js\nconst x = 1\n```\n\n| A | B |\n| --- | --- |\n| x | y |\n\n---\n\n$$\nx^2\n$$");
    expect(docToBlocks(blocksToDoc(blocks))).toEqual(blocks);
  });
  it("repairs duplicate ids after splits", () => {
    const blocks = markdownToBlocks("one\n\ntwo"); blocks[1]!.id = blocks[0]!.id;
    const saved = docToBlocks(blocksToDoc(blocks));
    expect(new Set(saved.map(b => b.id)).size).toBe(2);
    expect(blocksToMarkdown(saved)).toBe("one\n\ntwo\n");
  });
});

it("preserves typing made during a delayed conflict retry on the next save", async () => {
  const submitted = markdownToBlocks("first\n\nsecond\n\nthird");
  const remote = structuredClone(submitted); remote[1]!.content = [{ text: "bot updated second" }];
  const editor = structuredClone(submitted); editor[0]!.content = [{ text: "person updated first" }];
  const retryResult = mergeBlocks(submitted, editor, remote);
  let release!: () => void; const delayed = new Promise<void>(resolve => { release = resolve; });
  const sent = structuredClone(editor);
  const settled = delayed.then(() => mergeBlocks(sent, docToBlocks(blocksToDoc(editor)), retryResult));
  editor[2]!.content = [{ text: "typing while retry pending" }];
  release();
  const nextSave = await settled;
  expect(nextSave.map(b => b.content![0]!.text)).toEqual(["person updated first", "bot updated second", "typing while retry pending"]);
});
