import { describe, expect, it } from "vitest";

import { installOrigin, manifestFromHtml, manifestLink, manifestSchema, normalizeInstallUrl, parseMiniAppManifest, permissionLines } from "./mini-apps.ts";

const base = { id: "crm", name: "CRM", version: "1.0.0", entry: "index.html" };

describe("parseMiniAppManifest", () => {
  it("accepts a minimal manifest and fills defaults", () => {
    const r = parseMiniAppManifest(base, { needEntry: true });
    expect(r).toEqual({ ok: true, manifest: { id: "crm", name: "CRM", version: "1.0.0", entry: "index.html", permissions: [], collections: {}, description: undefined, author: undefined, icon: undefined } });
  });

  it("keeps known icons and collections", () => {
    const r = parseMiniAppManifest({ ...base, icon: "users", permissions: [], collections: { contacts: "name, stage", activity: "" }, author: " bos\nbot ", description: "a crm" });
    expect(r.ok && r.manifest).toMatchObject({ icon: "users", permissions: [], collections: { contacts: "name, stage", activity: "" }, author: "bos bot", description: "a crm" });
  });

  it("drops an unknown icon instead of failing", () => {
    const r = parseMiniAppManifest({ ...base, icon: "skull" });
    expect(r.ok && r.manifest.icon).toBeUndefined();
  });

  it.each([
    [{ ...base, id: "CRM" }, /id must/],
    [{ ...base, id: "a" }, /id must/],
    [{ ...base, name: "  " }, /name is missing/],
    [{ ...base, version: "1.0" }, /version/],
    [{ ...base, entry: "../secret.html" }, /entry/],
    [{ ...base, entry: "/index.html" }, /entry/],
    [{ ...base, entry: "https://evil.example/x.html" }, /entry/],
    [{ ...base, entry: "app.js" }, /entry/],
    [{ ...base, permissions: "bots:ask" }, /must be a list/],
    [{ ...base, permissions: ["bots:ask"] }, /asks for "bots:ask", which bos doesn't grant/],
    [{ ...base, permissions: ["secrets:read"] }, /asks for "secrets:read"/],
    [{ ...base, permissions: ["threads:read"] }, /asks for "threads:read"/],
    [{ ...base, network: ["api.example.com"] }, /wants to reach api\.example\.com/],
    [{ ...base, domains: "*" }, /wants to reach/],
    [{ ...base, collections: { Contacts: "" } }, /collection "Contacts"/],
    [{ ...base, collections: { constructor: "" } }, /collection "constructor"/],
    [{ ...base, collections: [] }, /collections must be an object/],
    [null, /json object/],
    [[base], /json object/],
  ])("refuses %j", (raw, error) => {
    const r = parseMiniAppManifest(raw);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(error);
  });

  it("needs an entry only when asked to", () => {
    const { entry: _entry, ...inline } = base;
    expect(parseMiniAppManifest(inline).ok).toBe(true);
    expect(parseMiniAppManifest(inline, { needEntry: true }).ok).toBe(false);
  });

  it("allows an empty network list", () => {
    expect(parseMiniAppManifest({ ...base, network: [] }).ok).toBe(true);
  });

  it("caps the number of collections", () => {
    const collections = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`c${i}`, ""]));
    expect(parseMiniAppManifest({ ...base, collections }).ok).toBe(false);
  });
});

describe("manifestFromHtml", () => {
  it("reads an inline manifest script", () => {
    const html = `<!doctype html><head><script type="application/bos-app+json">{"id":"notes","name":"Notes","version":"0.1.0"}</script></head>`;
    expect(manifestFromHtml(html)).toEqual({ id: "notes", name: "Notes", version: "0.1.0" });
  });

  it("marks a broken inline manifest as invalid", () => {
    const parsed = manifestFromHtml(`<script type="application/bos-app+json">{nope</script>`);
    expect(parseMiniAppManifest(parsed).ok).toBe(false);
  });

  it("falls back to the bos-app metas", () => {
    const html = `<meta name="bos-app" content="Seri Bridal CRM"><meta name="bos-app-icon" content="users"><meta name="bos-app-schema" content="contacts: name">`;
    const raw = manifestFromHtml(html) as Record<string, unknown>;
    expect(raw).toMatchObject({ id: "seri-bridal-crm", name: "Seri Bridal CRM", version: "1.0.0", icon: "users", schema: "contacts: name" });
    expect(parseMiniAppManifest(raw).ok).toBe(true);
  });

  it("returns null for a plain page", () => {
    expect(manifestFromHtml("<h1>hi</h1>")).toBeNull();
  });
});

describe("helpers", () => {
  it("finds a landing page's manifest link", () => {
    expect(manifestLink(`<link rel="bos-app-manifest" href="bos-app.json">`)).toBe("bos-app.json");
    expect(manifestLink(`<link rel="stylesheet" href="x.css">`)).toBeNull();
  });

  it("builds the bots' schema from collections", () => {
    const r = parseMiniAppManifest({ ...base, collections: { contacts: "name, stage", activity: "" } });
    expect(r.ok && manifestSchema(r.manifest)).toBe("contacts: name, stage; activity");
    const bare = parseMiniAppManifest(base);
    expect(bare.ok && manifestSchema(bare.manifest, "from meta")).toBe("from meta");
  });

  it("lists the app's own records", () => {
    const plain = permissionLines({ collections: { contacts: "" } }, "cash");
    expect(plain.map(l => l.key)).toEqual(["records"]);
    expect(plain[0]!.text).toBe("keep its own contacts");
    expect(permissionLines({ collections: {} }, "cash")[0]!.text).toBe("keep its own records");
  });

  it("names an install by the site it came from", () => {
    expect(installOrigin("https://bosbot.my/a/crm")).toBe(installOrigin("https://bosbot.my/a/crm/bos-app.json"));
    expect(installOrigin("https://evil.example/a/crm")).not.toBe(installOrigin("https://bosbot.my/a/crm"));
    expect(installOrigin("builtin:crm")).toBe("builtin");
  });

  it("normalizes install links to https only", () => {
    expect(normalizeInstallUrl("bosbot.my/a/crm")).toBe("https://bosbot.my/a/crm");
    expect(normalizeInstallUrl(" https://bosbot.my/a/crm/#x ")).toBe("https://bosbot.my/a/crm/");
    expect(normalizeInstallUrl("http://bosbot.my/a/crm")).toBeNull();
    expect(normalizeInstallUrl("file:///etc/passwd")).toBeNull();
    expect(normalizeInstallUrl("https://user:pw@bosbot.my/a")).toBeNull();
    expect(normalizeInstallUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeInstallUrl("")).toBeNull();
  });
});
