import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { handleInternalAppRoute, handleOwnerAppRoute } from "./app-routes.ts";
import { AppStore } from "./apps.ts";
import type { ResolvedMiniApp } from "./mini-app-fetch.ts";
import { handleMiniAppRoute, MiniAppPending } from "./mini-app-routes.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const bundle = (over: Partial<ResolvedMiniApp["manifest"]> = {}, html = "<div class=app>crm</div>"): ResolvedMiniApp => ({
  manifest: { id: "crm", name: "CRM", version: "1.0.0", permissions: [], collections: { contacts: "name, stage" }, ...over },
  html, source: "https://bosbot.my/a/crm/", bytes: html.length,
});

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "bos-mini-routes-"));
  dirs.push(dir);
  let clock = 1_000_000;
  const apps = new AppStore({ root: botId => join(dir, botId, "apps"), botIds: () => ["bot-1", "bot-2"] });
  const pending = new MiniAppPending(() => clock);
  let body: unknown = {};
  let ownerName: string | null = "Firaz";
  let next = bundle();
  const out: { status?: number; body?: any } = {};
  const http = {
    readBody: async () => body,
    json: (status: number, value: unknown) => { out.status = status; out.body = value; },
    send: (status: number, _h: Record<string, string>, value: Buffer | string) => { out.status = status; out.body = JSON.parse(String(value)); },
  };
  const call = (method: string, path: string, b: unknown = {}) => {
    body = b;
    return handleMiniAppRoute(method, path, {
      ...http, apps, pending, owner: () => ownerName, botIds: () => ["bot-1", "bot-2"],
      botName: id => id === "bot-1" ? "cash" : id === "bot-2" ? "bos" : null,
      resolveLink: async url => { if (url.includes("bad")) throw new Error("this page isn't a bos app: it has no manifest"); return next; },
      builtin: async id => id === "crm" ? { ...bundle(), source: "builtin:crm" } : null,
    });
  };
  const ownerRoute = (method: string, path: string) => handleOwnerAppRoute(method, path, new URLSearchParams(), {
    ...http, apps, access: () => ({ level: "owner", name: "Firaz", roomIds: () => [] }), botExists: () => true, roomExists: () => true,
    readPage: async () => { throw new Error("installed pages never read a conversation folder"); }, copyPage: async () => { throw new Error("never copied"); },
  });
  const internal = (method: string, path: string) => handleInternalAppRoute(method, path, new URLSearchParams(), {
    ...http, apps, botId: "bot-1", botName: "cash", threadId: "t1", roomId: null, botRoomIds: () => [], requireActive: () => {}, createFromTemplate: async () => null,
  });
  return {
    apps, out, call, ownerRoute, internal,
    setBundle: (b: ResolvedMiniApp) => { next = b; },
    asOwner: (yes: boolean) => { ownerName = yes ? "Firaz" : null; },
    tick: (ms: number) => { clock += ms; },
  };
}

async function install(h: ReturnType<typeof harness>, botId = "bot-1") {
  await h.call("POST", "/api/apps/install/preview", { url: "bosbot.my/a/crm" });
  const token = h.out.body.token;
  await h.call("POST", "/api/apps/install", { token, botId });
  return h.out.body.app;
}

describe("mini app install routes", () => {
  it("previews before installing, and installs exactly what was previewed", async () => {
    const h = harness();
    await h.call("POST", "/api/apps/install/preview", { url: "bosbot.my/a/crm" });
    expect(h.out.status).toBe(200);
    expect(h.out.body.preview).toMatchObject({ manifest: { id: "crm" }, host: "bosbot.my", builtin: false, existing: {} });
    expect(h.apps.list("bot-1")).toEqual([]);
    const token = h.out.body.token;
    h.setBundle(bundle({}, "<div>swapped after preview</div>"));
    await h.call("POST", "/api/apps/install", { token, botId: "bot-1" });
    expect(h.out.body).toMatchObject({ updated: false, app: { name: "CRM", installed: { version: "1.0.0" } } });
    expect(h.apps.installedPage(h.out.body.app.id)?.html).toBe("<div class=app>crm</div>");
    // a token works once
    await h.call("POST", "/api/apps/install", { token, botId: "bot-2" });
    expect(h.out.status).toBe(410);
  });

  it("expires previews", async () => {
    const h = harness();
    await h.call("POST", "/api/apps/install/preview", { url: "bosbot.my/a/crm" });
    const token = h.out.body.token;
    h.tick(11 * 60_000);
    await h.call("POST", "/api/apps/install", { token, botId: "bot-1" });
    expect(h.out.status).toBe(410);
  });

  it("shows an update for a bot that already has it", async () => {
    const h = harness();
    const app = await install(h);
    h.setBundle(bundle({ version: "1.1.0" }));
    await h.call("POST", "/api/apps/install/preview", { url: "bosbot.my/a/crm" });
    expect(h.out.body.preview.existing).toEqual({ "bot-1": { appId: app.id, version: "1.0.0" } });
    await h.call("POST", "/api/apps/install", { token: h.out.body.token, botId: "bot-1" });
    expect(h.out.body).toMatchObject({ updated: true, app: { id: app.id, installed: { version: "1.1.0" } } });
  });

  it("never lets another site update an install that has the same id", async () => {
    const h = harness();
    const app = await install(h);
    h.apps.write(app.id, [{ op: "put", collection: "contacts", id: "c1", record: { name: "Ali" } }], "Firaz");
    h.setBundle({ ...bundle({ version: "9.0.0" }, "<div>someone else's crm</div>"), source: "https://evil.example/crm/" });
    await h.call("POST", "/api/apps/install/preview", { url: "evil.example/crm" });
    expect(h.out.body.preview.existing).toEqual({});
    await h.call("POST", "/api/apps/install", { token: h.out.body.token, botId: "bot-1" });
    expect(h.out.body).toMatchObject({ updated: false });
    expect(h.out.body.app.id).not.toBe(app.id);
    expect(h.apps.records(h.out.body.app.id, "contacts")).toEqual([]);
    expect(h.apps.installedPage(app.id)?.html).toBe("<div class=app>crm</div>");
  });

  it("installs a builtin and reports a bad link plainly", async () => {
    const h = harness();
    await h.call("POST", "/api/apps/install/preview", { builtin: "crm" });
    expect(h.out.body.preview).toMatchObject({ builtin: true, host: "bos", source: "builtin:crm" });
    await h.call("POST", "/api/apps/install/preview", { builtin: "nope" });
    expect(h.out.status).toBe(404);
    await h.call("POST", "/api/apps/install/preview", { url: "x.dev/bad" });
    expect(h.out).toMatchObject({ status: 422, body: { error: /no manifest/ } });
    await h.call("POST", "/api/apps/install/preview", {});
    expect(h.out.status).toBe(400);
  });

  it("is owner only", async () => {
    const h = harness();
    h.asOwner(false);
    await h.call("POST", "/api/apps/install/preview", { url: "bosbot.my/a/crm" });
    expect(h.out.status).toBe(403);
    await h.call("POST", "/api/apps/install", { token: "x", botId: "bot-1" });
    expect(h.out.status).toBe(403);
  });

  it("needs a real bot", async () => {
    const h = harness();
    await h.call("POST", "/api/apps/install/preview", { url: "bosbot.my/a/crm" });
    await h.call("POST", "/api/apps/install", { token: h.out.body.token, botId: "bot-9" });
    expect(h.out.status).toBe(400);
  });

  it("serves the installed page from its data folder and refuses a copy", async () => {
    const h = harness();
    const app = await install(h);
    await h.ownerRoute("GET", `/api/apps/${app.id}/page`);
    expect(h.out).toMatchObject({ status: 200, body: { html: "<div class=app>crm</div>", app: { id: app.id } } });
    await h.ownerRoute("POST", `/api/apps/${app.id}/duplicate`);
    expect(h.out.status).toBe(409);
  });

  it("tells the bot an app was installed from a link, and lets it write", async () => {
    const h = harness();
    const app = await install(h);
    await h.internal("GET", "/api/internal/apps");
    expect(h.out.body.apps[0]).toMatchObject({ app_id: app.id, schema: "contacts: name, stage", installed: { version: "1.0.0", source: "https://bosbot.my/a/crm/", permissions: [] } });
  });
});
