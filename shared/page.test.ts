import { describe, expect, it } from "vitest";
import {
  applyPageEdits, attributeBlocks, blockHash, blocksToMarkdown, markdownToBlocks, mergeBlocks, pageAskRequest,
  reconcileBlockIds, runsToMarkdown, splitMarkdownTitle, validateBlocks, type PageAuthor, type PageBlock,
} from "./page.ts";

const strip = (blocks: PageBlock[]) => blocks.map(({ id: _id, ...rest }) => rest);
const human: PageAuthor = { kind: "human", id: "owner", name: "Firaz" };
const bot: PageAuthor = { kind: "bot", id: "bot-1", name: "bos" };

describe("page markdown", () => {
  it("round-trips every block type", () => {
    const markdown = [
      "## Plan", "",
      "Some **bold *and italic*** text with `code`, ~~gone~~, <u>under</u>, <mark>lit</mark> and [a link](https://example.com).", "",
      "- one", "    - nested", "- two", "",
      "1. first", "2. second", "",
      "- [ ] todo", "- [x] done", "",
      "> quoted line", "",
      "> [!💡] remember this", "",
      "```ts", "const x = 1;", "```", "",
      "$$", "e = mc^2", "$$", "",
      "---", "",
      "![chart](https://example.com/c.png)", "",
      "| a | b |", "| --- | --- |", "| 1 | **2** |", "",
    ].join("\n");
    const blocks = markdownToBlocks(markdown);
    expect(blocks.map(b => b.type)).toEqual([
      "heading", "paragraph", "bullet", "bullet", "bullet", "numbered", "numbered", "todo", "todo",
      "quote", "callout", "code", "math", "divider", "image", "table",
    ]);
    expect(blocks[3]!.indent).toBe(1);
    expect(blocks[8]!.checked).toBe(true);
    expect(blocks[10]!.emoji).toBe("💡");
    expect(blocks[11]).toMatchObject({ code: "const x = 1;", language: "ts" });
    expect(blocks[12]!.code).toBe("e = mc^2");
    const again = markdownToBlocks(blocksToMarkdown(blocks));
    expect(strip(again)).toEqual(strip(blocks));
  });

  it("keeps marks and whitespace valid when they change mid-span", () => {
    const md = runsToMarkdown([{ text: "bold ", b: true }, { text: "both", b: true, i: true }, { text: " tail" }]);
    expect(md).toBe("**bold *both*** tail");
    expect(strip(markdownToBlocks(md))[0]!.content).toEqual([{ text: "bold ", b: true }, { text: "both", b: true, i: true }, { text: " tail" }]);
  });

  it("escapes markdown syntax typed as text", () => {
    const blocks = validateBlocks([{ type: "paragraph", content: [{ text: "# not a heading *nor* [link]" }] }]);
    const again = markdownToBlocks(blocksToMarkdown(blocks));
    expect(again[0]).toMatchObject({ type: "paragraph", content: [{ text: "# not a heading *nor* [link]" }] });
  });

  it("maps github alerts to callouts and splits the title", () => {
    expect(markdownToBlocks("> [!WARNING] careful")[0]).toMatchObject({ type: "callout", emoji: "⚠️", content: [{ text: "careful" }] });
    expect(splitMarkdownTitle("# Launch plan\n\nbody")).toEqual({ title: "Launch plan", body: "\nbody" });
  });

  it("drops unsafe links and images", () => {
    const blocks = markdownToBlocks("[x](javascript:alert(1)) ![y](http://plain.example/a.png)");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.content!.every(r => !r.href)).toBe(true);
    expect(() => validateBlocks([{ type: "image", src: "data:image/png;base64,AAAA" }])).toThrow(/https/);
  });
});

describe("page identity", () => {
  it("keeps ids of unchanged and edited blocks on a full rewrite", () => {
    const before = markdownToBlocks("intro\n\nmiddle\n\nend");
    const after = reconcileBlockIds(before, markdownToBlocks("intro\n\nmiddle, revised\n\nnew line\n\nend"));
    expect(after[0]!.id).toBe(before[0]!.id);
    expect(after[1]!.id).toBe(before[1]!.id);
    expect(after[3]!.id).toBe(before[2]!.id);
    expect(new Set(after.map(b => b.id)).size).toBe(4);
  });

  it("attributes only changed blocks to the saver", () => {
    const blocks = markdownToBlocks("a\n\nb");
    const first = attributeBlocks({}, blocks, human, 1);
    const edited = [blocks[0]!, { ...blocks[1]!, content: [{ text: "b2" }] }];
    const second = attributeBlocks(first, edited, bot, 2);
    expect(second[blocks[0]!.id]!.author).toEqual(human);
    expect(second[blocks[1]!.id]).toMatchObject({ author: bot, at: 2 });
  });

  it("merges a racing bot edit with the person's typing", () => {
    const base = markdownToBlocks("a\n\nb\n\nc");
    const mine = [{ ...base[0]!, content: [{ text: "a mine" }] }, base[1]!, { id: "bnewmine1", type: "paragraph" as const, content: [{ text: "new" }] }, base[2]!];
    const theirs = [base[0]!, { ...base[1]!, content: [{ text: "b bot" }] }];
    const merged = mergeBlocks(base, mine, theirs);
    expect(merged.map(b => b.content?.[0]?.text)).toEqual(["a mine", "b bot", "new"]);
  });

  it("applies bot edit operations by block id", () => {
    const blocks = markdownToBlocks("- [ ] ship\n\nold");
    const next = applyPageEdits(blocks, [
      { op: "check", blockId: blocks[0]!.id, checked: true },
      { op: "replace", blockId: blocks[1]!.id, markdown: "new text" },
      { op: "append", markdown: "## Next" },
    ]);
    expect(next[0]!.checked).toBe(true);
    expect(next[1]).toMatchObject({ id: blocks[1]!.id, content: [{ text: "new text" }] });
    expect(next[2]).toMatchObject({ type: "heading", level: 2 });
    expect(() => applyPageEdits(blocks, [{ op: "delete", blockId: "bmissing0" }])).toThrow(/read the page again/);
  });

  it("hashes content, not ids", () => {
    const [a] = markdownToBlocks("same");
    expect(blockHash(a!)).toBe(blockHash({ ...a!, id: "other1" }));
  });

  it("phrases editor requests for the bot", () => {
    const text = pageAskRequest({ pageId: "p-abcdefgh1234", title: "Plan", instruction: "make it shorter", blockIds: ["b1234"], quote: "long text" });
    expect(text).toContain("page_read");
    expect(text).toContain("b1234");
  });
});
