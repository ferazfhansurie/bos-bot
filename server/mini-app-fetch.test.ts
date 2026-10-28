import { describe, expect, it } from "vitest";

import { createPublicFetcher, resolveInstallLink, type FetchedFile, type MiniAppFetcher } from "./mini-app-fetch.ts";

const manifest = { id: "crm", name: "CRM", version: "1.0.0", entry: "app.html", collections: { contacts: "name" } };
const appHtml = "<!doctype html><title>crm</title><div class=app></div>";

function site(files: Record<string, string | { body: string; type?: string; url?: string }>): MiniAppFetcher & { asked: string[] } {
  const asked: string[] = [];
  const fetcher = (async (url: URL, maxBytes: number): Promise<FetchedFile> => {
    asked.push(url.toString());
    const hit = files[url.toString()];
    if (hit === undefined) throw new Error(`404 ${url}`);
    const file = typeof hit === "string" ? { body: hit } : hit;
    if (Buffer.byteLength(file.body) > maxBytes) throw new Error("too big");
    return { url: file.url ?? url.toString(), contentType: file.type ?? (file.body.trimStart().startsWith("{") ? "application/json" : "text/html"), body: file.body };
  }) as MiniAppFetcher & { asked: string[] };
  fetcher.asked = asked;
  return fetcher;
}

describe("resolveInstallLink", () => {
  it("follows a manifest json to its entry", async () => {
    const r = await resolveInstallLink("bosbot.my/a/crm/bos-app.json", site({
      "https://bosbot.my/a/crm/bos-app.json": JSON.stringify(manifest),
      "https://bosbot.my/a/crm/app.html": appHtml,
    }));
    expect(r).toMatchObject({ manifest: { id: "crm", entry: "app.html" }, html: appHtml, source: "https://bosbot.my/a/crm/bos-app.json" });
  });

  it("follows a landing page's manifest link", async () => {
    const fetcher = site({
      "https://bosbot.my/a/crm/": `<html><head><link rel="bos-app-manifest" href="bos-app.json"></head>`,
      "https://bosbot.my/a/crm/bos-app.json": JSON.stringify(manifest),
      "https://bosbot.my/a/crm/app.html": appHtml,
    });
    const r = await resolveInstallLink("https://bosbot.my/a/crm/", fetcher);
    expect(r.html).toBe(appHtml);
    expect(fetcher.asked).toHaveLength(3);
  });

  it("reuses the landing page when it is the entry", async () => {
    const landing = `<html><head><link rel="bos-app-manifest" href="bos-app.json"></head><div class=app>`;
    const fetcher = site({
      "https://x.dev/app.html": landing,
      "https://x.dev/bos-app.json": JSON.stringify(manifest),
    });
    expect((await resolveInstallLink("https://x.dev/app.html", fetcher)).html).toBe(landing);
    expect(fetcher.asked).toHaveLength(2);
  });

  it("reads a single file with an inline manifest or metas", async () => {
    const inline = `<script type="application/bos-app+json">{"id":"notes","name":"Notes","version":"0.2.0","permissions":[]}</script><div>`;
    expect((await resolveInstallLink("https://x.dev/notes.html", site({ "https://x.dev/notes.html": inline }))).manifest).toMatchObject({ id: "notes", permissions: [] });
    const metas = `<meta name="bos-app" content="Stock Sheet"><meta name="bos-app-schema" content="items: name, qty">`;
    const r = await resolveInstallLink("https://x.dev/s.html", site({ "https://x.dev/s.html": metas }));
    expect(r).toMatchObject({ manifest: { id: "stock-sheet", name: "Stock Sheet" }, schema: "items: name, qty" });
  });

  it.each([
    ["http://x.dev/a.html", {}, /https link/],
    ["https://x.dev/plain.html", { "https://x.dev/plain.html": "<h1>hi</h1>" }, /no manifest/],
    ["https://x.dev/m.json", { "https://x.dev/m.json": JSON.stringify({ ...manifest, entry: "https://evil.dev/a.html" }) }, /entry/],
    ["https://x.dev/m.json", { "https://x.dev/m.json": "{nope" }, /valid json/],
    ["https://x.dev/m.json", { "https://x.dev/m.json": JSON.stringify({ ...manifest, permissions: ["secrets:read"] }) }, /secrets:read/],
    ["https://x.dev/", { "https://x.dev/": `<link rel="bos-app-manifest" href="https://evil.dev/m.json">` }, /same site/],
    ["https://x.dev/m.json", { "https://x.dev/m.json": { body: JSON.stringify(manifest), url: "https://evil.dev/m.json" } }, /same site/],
    ["https://x.dev/m.json", { "https://x.dev/m.json": JSON.stringify(manifest), "https://x.dev/app.html": { body: appHtml, url: "https://evil.dev/app.html" } }, /same site/],
    ["https://x.dev/m.json", { "https://x.dev/m.json": JSON.stringify(manifest), "https://x.dev/app.html": "just text" }, /isn't html/],
  ] as const)("refuses %s (%#)", async (link, files, error) => {
    await expect(resolveInstallLink(link, site(files as never))).rejects.toThrow(error);
  });
});

describe("createPublicFetcher", () => {
  it.each(["127.0.0.1", "10.1.2.3", "192.168.1.20", "100.64.0.10", "169.254.169.254", "::1", "fd00::1", "::ffff:127.0.0.1"])("won't fetch from %s", async (address) => {
    const fetcher = createPublicFetcher({ lookup: async () => [{ address, family: address.includes(":") ? 6 : 4 }] });
    await expect(fetcher(new URL("https://rebind.example/app.html"), 1000)).rejects.toThrow(/isn't a public internet address/);
  });

  it("refuses when any answer is private", async () => {
    const fetcher = createPublicFetcher({ lookup: async () => [{ address: "1.1.1.1", family: 4 }, { address: "10.0.0.1", family: 4 }] });
    await expect(fetcher(new URL("https://mixed.example/"), 1000)).rejects.toThrow(/public/);
  });

  it("refuses a non-https url", async () => {
    const fetcher = createPublicFetcher({ lookup: async () => [{ address: "1.1.1.1", family: 4 }] });
    await expect(fetcher(new URL("http://x.example/"), 1000)).rejects.toThrow(/https/);
  });
});

describe("builtin apps", () => {
  it("builds the crm from its starter", async () => {
    const { readFile } = await import("node:fs/promises");
    const { builtinMiniApp } = await import("./mini-app-fetch.ts");
    const r = await builtinMiniApp("crm", name => readFile(`skills/apps/templates/${name}.html`, "utf8"));
    expect(r?.manifest).toMatchObject({ id: "crm", name: "CRM", icon: "users", author: "bos bot", permissions: [] });
    expect(Object.keys(r!.manifest.collections)).toEqual(["contacts", "activities", "settings"]);
    expect(r?.source).toBe("builtin:crm");
    expect(await builtinMiniApp("constructor", async () => "")).toBeNull();
    expect(await builtinMiniApp("nope", async () => "")).toBeNull();
  });

  it("splits a schema into collections", async () => {
    const { schemaCollections } = await import("./mini-app-fetch.ts");
    expect(schemaCollections("a: x (p|q), y; b_2: z; not a name")).toEqual({ a: "x (p|q), y", b_2: "z; not a name" });
    expect(schemaCollections(undefined)).toEqual({});
  });

  it("gives up when the name lookup stalls past the deadline", async () => {
    const fetcher = createPublicFetcher({ timeoutMs: 50, lookup: () => new Promise(() => {}) });
    const began = Date.now();
    await expect(fetcher(new URL("https://slow.example.com/"), 1024)).rejects.toThrow("took too long");
    expect(Date.now() - began).toBeLessThan(2000);
  });
});
