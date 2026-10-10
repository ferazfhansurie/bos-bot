import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HomeLinks, parseHomeAddress, rewriteHomeUrls } from "./homes.ts";

describe("parseHomeAddress", () => {
  it("takes the code from a pairing link", () => {
    expect(parseHomeAddress("https://box.example.com/pair#code=ABCD-EFGH-IJKL")).toEqual({ origin: "https://box.example.com", code: "ABCD-EFGH-IJKL" });
  });
  it("allows http only on loopback and the tailnet", () => {
    expect(parseHomeAddress("http://100.64.0.10:8799", "ABCD-EFGH").origin).toBe("http://100.64.0.10:8799");
    expect(parseHomeAddress("http://bos-laptop.example-tailnet.ts.net:8799", "ABCD-EFGH").origin).toBe("http://bos-laptop.example-tailnet.ts.net:8799");
    expect(() => parseHomeAddress("http://example.com", "ABCD-EFGH")).toThrow(/https/);
  });
  it("defaults a bare host to https and needs a code", () => {
    expect(parseHomeAddress("box.example.com", "ABCD-EFGH").origin).toBe("https://box.example.com");
    expect(() => parseHomeAddress("box.example.com")).toThrow(/pairing code/);
  });
});

describe("rewriteHomeUrls", () => {
  it("points api paths at the proxy but leaves escaped text alone", () => {
    const body = JSON.stringify({ avatarUrl: "/api/bots/b1/avatar", text: 'see "/api/x"' });
    const out = JSON.parse(rewriteHomeUrls(body, "h1"));
    expect(out.avatarUrl).toBe("/api/homes/h1/proxy/api/bots/b1/avatar");
    expect(out.text).toBe('see "/api/x"');
  });
});

describe("HomeLinks", () => {
  const fakeFetch = (scopes: string[]) => (async (input: URL | string) => {
    const url = String(input);
    if (url.endsWith("/.well-known/openmausbot/environment")) return Response.json({ environmentId: "env-other", label: "bos-laptop" });
    if (url.endsWith("/api/auth/pair")) return Response.json({ token: "secret-token", session: { scopes } });
    return Response.json({ ok: true });
  }) as typeof fetch;

  it("stores the session privately and never lists the token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "homes-"));
    const links = new HomeLinks(dir, { environmentId: "env-self", label: () => "mac" }, fakeFetch(["admin", "client"]));
    const home = await links.add("https://laptop.example.com", "ABCD-EFGH");
    expect(home).toMatchObject({ id: "env-other", name: "bos-laptop", origin: "https://laptop.example.com" });
    expect(JSON.stringify(links.list())).not.toContain("secret-token");
    expect(readFileSync(join(dir, "homes.json"), "utf8")).toContain("secret-token");
    expect(statSync(join(dir, "homes.json")).mode & 0o777).toBe(0o600);
    expect(new HomeLinks(dir, { environmentId: "env-self", label: () => "mac" }).list()).toHaveLength(1);
  });

  it("refuses a code without owner access", async () => {
    const links = new HomeLinks(mkdtempSync(join(tmpdir(), "homes-")), { environmentId: "env-self", label: () => "mac" }, fakeFetch(["client"]));
    await expect(links.add("https://laptop.example.com", "ABCD-EFGH")).rejects.toThrow(/owner access/);
  });

  it("refuses linking to itself", async () => {
    const links = new HomeLinks(mkdtempSync(join(tmpdir(), "homes-")), { environmentId: "env-other", label: () => "mac" }, fakeFetch(["admin", "client"]));
    await expect(links.add("https://laptop.example.com", "ABCD-EFGH")).rejects.toThrow(/this computer/);
  });

  it("proxies with the home's token and rewrites json", async () => {
    let seenAuth = "";
    let seenPath = "";
    const upstream = createServer((req, res) => {
      seenAuth = String(req.headers.authorization);
      seenPath = String(req.url);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ avatarUrl: "/api/bots/b1/avatar" }));
    });
    await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
    const port = (upstream.address() as { port: number }).port;
    const dir = mkdtempSync(join(tmpdir(), "homes-"));
    const realFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/.well-known/openmausbot/environment")) return Response.json({ environmentId: "env-other", label: "laptop" });
      if (url.endsWith("/api/auth/pair")) return Response.json({ token: "tok", session: { scopes: ["admin", "client"] } });
      return fetch(input, init);
    };
    const links = new HomeLinks(dir, { environmentId: "env-self", label: () => "mac" }, realFetch);
    await links.add(`http://127.0.0.1:${port}`, "ABCD-EFGH");
    const front = createServer((req, res) => {
      const url = new URL(req.url!, "http://x");
      const match = /^\/api\/homes\/([\w-]+)\/proxy(\/.*)$/.exec(url.pathname)!;
      void links.proxy(req, res, match[1], match[2], url.search);
    });
    await new Promise<void>(resolve => front.listen(0, "127.0.0.1", resolve));
    const frontPort = (front.address() as { port: number }).port;
    const answer = await fetch(`http://127.0.0.1:${frontPort}/api/homes/env-other/proxy/api/bots?messages=5`).then(r => r.json());
    expect(seenAuth).toBe("Bearer tok");
    expect(seenPath).toBe("/api/bots?messages=5");
    expect(answer).toEqual({ avatarUrl: "/api/homes/env-other/proxy/api/bots/b1/avatar" });
    upstream.close();
    front.close();
  });
});
