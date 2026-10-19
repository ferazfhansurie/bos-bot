import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { pageDocx, pageHtml, pageMarkdownFile } from "./page-export.ts";
import { PageStore, type PageChange } from "./pages.ts";
import type { PageAuthor } from "../shared/page.ts";

const owner: PageAuthor = { kind: "human", id: "owner", name: "Firaz" };
const bos: PageAuthor = { kind: "bot", id: "bot-1", name: "bos" };
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "bos-pages-"));
  dirs.push(dir);
  let clock = 1_000_000;
  const changes: PageChange[] = [];
  const store = new PageStore({ root: botId => join(dir, botId, "pages"), now: () => clock, onChange: c => changes.push(c) });
  return { dir, store, changes, tick: (ms: number) => { clock += ms; } };
}

describe("page store", () => {
  it("creates, saves and refuses stale revisions", () => {
    const { store, dir, changes } = fixture();
    const page = store.create("bot-1", { markdown: "# Launch\n\nfirst line" }, owner);
    expect(page).toMatchObject({ title: "Launch", revision: 1 });
    expect(page.blocks).toHaveLength(1);
    const saved = store.save("bot-1", page.id, { baseRevision: 1, blocks: [...page.blocks, { type: "paragraph", content: [{ text: "two" }] }] }, owner);
    expect(saved.revision).toBe(2);
    expect(() => store.save("bot-1", page.id, { baseRevision: 1, blocks: [] }, owner)).toThrow(/changed since/);
    expect(changes.map(c => c.revision)).toEqual([1, 2]);
    expect(statSync(join(dir, "bot-1", "pages", `${page.id}.json`)).mode & 0o777).toBe(0o600);
    const reloaded = new PageStore({ root: botId => join(dir, botId, "pages") });
    expect(reloaded.get("bot-1", page.id).blocks).toHaveLength(2);
  });

  it("checkpoints before a bot edit so it can be undone, and attributes blocks", () => {
    const { store } = fixture();
    const page = store.create("bot-1", { title: "Plan", markdown: "keep\n\nchange me" }, owner);
    const keepId = page.blocks[0]!.id, changeId = page.blocks[1]!.id;
    const edited = store.edit("bot-1", page.id, [{ op: "replace", blockId: changeId, markdown: "changed by bos" }], bos);
    expect(edited.attribution[keepId]!.author).toEqual(owner);
    expect(edited.attribution[changeId]!.author).toEqual(bos);
    const before = edited.versions.at(-1)!;
    expect(before).toMatchObject({ reason: "before-bot-edit", n: 1 });
    const restored = store.restoreVersion("bot-1", page.id, before.id, owner);
    expect(restored.blocks.map(b => b.content?.[0]?.text)).toEqual(["keep", "change me"]);
    expect(restored.activity.map(a => a.action)).toEqual(["imported", "edited", "restored"]);
  });

  it("keeps comments on blocks across a full rewrite", () => {
    const { store } = fixture();
    const page = store.create("bot-1", { markdown: "alpha\n\nbeta" }, owner);
    const commented = store.comment("bot-1", page.id, { blockId: page.blocks[1]!.id, quote: "beta", text: "expand this" }, owner);
    const rewritten = store.write("bot-1", page.id, { markdown: "alpha\n\nbeta, expanded\n\ngamma" }, bos);
    expect(rewritten.blocks[1]!.id).toBe(commented.comments[0]!.blockId);
    const replied = store.updateComment("bot-1", page.id, commented.comments[0]!.id, { reply: "done", resolved: true }, bos);
    expect(replied.comments[0]).toMatchObject({ resolved: { by: bos }, replies: [{ text: "done" }] });
  });

  it("lists pinned first, trashes, purges after 30 days and deletes assets", () => {
    const { store, dir, tick } = fixture();
    const a = store.create("bot-1", { title: "a" }, owner);
    tick(10);
    const b = store.create("bot-1", { title: "b" }, owner);
    store.setPinned("bot-1", a.id, true, owner);
    expect(store.list("bot-1").map(p => p.title)).toEqual(["a", "b"]);
    const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
    expect(store.saveAsset("bot-1", b.id, "image/png", png)).toMatch(/^asset:[a-z0-9]+\.png$/);
    expect(() => store.saveAsset("bot-1", b.id, "image/png", Buffer.from("GIF89a"))).toThrow(/does not match/);
    store.setTrashed("bot-1", b.id, true, owner);
    expect(store.list("bot-1").map(p => p.title)).toEqual(["a"]);
    expect(store.list("bot-1", { trash: true }).map(p => p.title)).toEqual(["b"]);
    tick(31 * 86_400_000);
    expect(store.list("bot-1", { trash: true })).toEqual([]);
    expect(readdirSync(join(dir, "bot-1", "pages"))).toEqual([`${a.id}.json`]);
  });

  it("logs a view at most every ten minutes", () => {
    const { store, tick } = fixture();
    const page = store.create("bot-1", { title: "x" }, owner);
    store.viewed("bot-1", page.id, owner);
    store.viewed("bot-1", page.id, owner);
    tick(11 * 60_000);
    store.viewed("bot-1", page.id, owner);
    expect(store.get("bot-1", page.id).activity.filter(a => a.action === "viewed")).toHaveLength(2);
  });
});

describe("page export", () => {
  it("writes markdown, html and a docx", async () => {
    const { store } = fixture();
    const page = store.create("bot-1", { markdown: "# Report\n\n## Summary\n\n- **one**\n- two\n\n1. a\n2. b\n\n| x | y |\n| - | - |\n| 1 | 2 |\n\n> [!💡] note\n\n```js\nlet a = 1\n```" }, owner);
    expect(pageMarkdownFile(page)).toContain("## Summary");
    const html = pageHtml(page, () => null);
    expect(html).toContain("<table>");
    expect(html).toContain('<div class="callout">');
    expect(html).not.toContain("<script");
    const docx = await pageDocx(page, () => null);
    expect(docx.subarray(0, 2).toString("latin1")).toBe("PK");
  });
});

it("a rejected oversized save leaves the cache and persisted revision intact", () => {
  const { store } = fixture();
  const p = store.create("bot-1", { markdown: "keep this" }, owner);
  const huge = Array.from({ length: 110 }, (_, i) => ({ id: `block${i}`, type: "paragraph", content: [{ text: "x".repeat(19999) }] }));
  expect(() => store.save("bot-1", p.id, { baseRevision: 1, blocks: huge }, owner)).toThrow(/too large/);
  expect(store.get("bot-1", p.id)).toEqual(p);
});
it("large valid documents remain editable with bounded checkpoint history", () => {
  const { store } = fixture();
  const blocks = Array.from({ length: 58 }, (_, i) => ({ id: `block${i}`, type: "paragraph", content: [{ text: "x".repeat(19000) }] }));
  const p = store.create("bot-1", { blocks }, owner);
  const next = store.save("bot-1", p.id, { baseRevision: p.revision, title: "changed" }, bos);
  expect(next.title).toBe("changed");
  expect(next.versions).toHaveLength(1);
  expect(store.get("bot-1", p.id).title).toBe("changed");
});
