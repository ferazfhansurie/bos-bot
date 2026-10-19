import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { handleInternalPageRoute, handleOwnerPageRoute } from "./page-routes.ts";
import { PageStore } from "./pages.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function harness(body: unknown = {}) {
  const dir = mkdtempSync(join(tmpdir(), "bos-page-routes-"));
  dirs.push(dir);
  const pages = new PageStore({ root: botId => join(dir, botId, "pages") });
  const out: { status?: number; body?: any } = {};
  const http = {
    readBody: async () => body,
    json: (status: number, value: unknown) => { out.status = status; out.body = value; },
    send: (status: number, _headers: Record<string, string>, value: Buffer | string) => { out.status = status; out.body = value; },
  };
  return { pages, out, http };
}

const owner = { kind: "human" as const, id: "owner", name: "Firaz" };
const bot = { kind: "bot" as const, id: "bot-1", name: "bos" };

describe("page routes", () => {
  it("refuses a non-owner before touching the store", async () => {
    const { pages, out, http } = harness({ title: "x" });
    await handleOwnerPageRoute("POST", "/api/pages/bot-1", new URLSearchParams(), {
      ...http, pages, owner: () => owner, botExists: () => true, directBotOf: () => null,
      assertOwner: () => { throw Object.assign(new Error("owner access required"), { status: 403 }); },
    });
    expect(out.status).toBe(403);
    expect(pages.list("bot-1")).toEqual([]);
  });

  it("keeps a thread link only for the bot's own direct conversation", async () => {
    const { pages, out, http } = harness({ title: "x", threadId: "t-other" });
    await handleOwnerPageRoute("POST", "/api/pages/bot-1", new URLSearchParams(), {
      ...http, pages, owner: () => owner, botExists: () => true, assertOwner: () => {},
      directBotOf: id => id === "t-other" ? "bot-2" : null,
    });
    expect(out.status).toBe(200);
    expect(out.body.page.threadId).toBeUndefined();
  });

  it("gives bots their own pages in direct chats and nothing in rooms", async () => {
    const { pages, out, http } = harness({ title: "Brief", markdown: "hello" });
    const deps = { ...http, pages, botId: "bot-1", threadId: "t-1", bot, requireActive: () => {} };
    await handleInternalPageRoute("POST", "/api/internal/pages", new URLSearchParams(), { ...deps, inRoom: true });
    expect(out.status).toBe(403);
    await handleInternalPageRoute("POST", "/api/internal/pages", new URLSearchParams(), { ...deps, inRoom: false });
    expect(out.status).toBe(200);
    expect(out.body.page.text).toContain("hello");
    expect(pages.list("bot-2")).toEqual([]);
  });

  it("rejects malformed bot edits", async () => {
    const { pages, out, http } = harness({ base_revision: 1, edits: [{ op: "replace" }] });
    const page = pages.create("bot-1", { markdown: "a", threadId: "t-1" }, owner);
    await handleInternalPageRoute("POST", `/api/internal/pages/${page.id}/edit`, new URLSearchParams(), {
      ...http, pages, botId: "bot-1", threadId: "t-1", bot, inRoom: false, requireActive: () => {},
    });
    expect(out.status).toBe(400);
    expect(out.body.error).toMatch(/block_id/);
  });
});

it("refuses stale bot writes and preserves the human edit", async () => {
  const { pages, out, http } = harness({ base_revision: 1, markdown: "stale bot content" });
  const p = pages.create("bot-1", { markdown: "original", threadId: "t-1" }, owner);
  pages.save("bot-1", p.id, { baseRevision: 1, blocks: [{ id: p.blocks[0]!.id, type: "paragraph", content: [{ text: "human edit" }] }] }, owner);
  await handleInternalPageRoute("POST", `/api/internal/pages/${p.id}/write`, new URLSearchParams(), {
    ...http, pages, botId: "bot-1", threadId: "t-1", bot, inRoom: false, requireActive: () => {},
  });
  expect(out.status).toBe(409);
  expect(pages.get("bot-1", p.id).blocks[0]!.content![0]!.text).toBe("human edit");
});

it("does not expose another conversation's pages to the bot", async () => {
  const { pages, out, http } = harness();
  const p = pages.create("bot-1", { markdown: "private in other thread", threadId: "t-other" }, owner);
  const deps = { ...http, pages, botId: "bot-1", threadId: "t-1", bot, inRoom: false, requireActive: () => {} };
  await handleInternalPageRoute("GET", "/api/internal/pages", new URLSearchParams(), deps);
  expect(out.body.pages).toEqual([]);
  await handleInternalPageRoute("GET", `/api/internal/pages/${p.id}`, new URLSearchParams(), deps);
  expect(out.status).toBe(404);
});
