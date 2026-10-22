// The phone-browser companion at https://app.bosbot.my.
//
// A browser is refused everywhere by default. These pin the one exception:
// that exact origin, only on the hosted listener, only for the web subset of
// routes, still behind the device token, and never with credentials mode.
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createProxyHandler } from "../src/proxy.ts";
import { WEB_COMPANION_ORIGIN } from "../src/routes.ts";
import { companionStatusSnapshot } from "../src/status.ts";

const TOKEN = "omb_test_token";
const WEB_TOKEN = "omb_web_token";
let lastScope: string | undefined;
let harness: Server;
let hosted: Server;
let device: Server;
let hostedPort = 0;
let devicePort = 0;
let harnessHits = 0;

const listen = (server: Server): Promise<number> =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
const close = (server: Server | undefined): Promise<void> =>
  new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));

const ask = async (
  port: number,
  path: string,
  init: { method?: string; origin?: string | null; token?: string | null; headers?: Record<string, string>; body?: string } = {},
) => {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.origin !== null) headers.origin = init.origin ?? WEB_COMPANION_ORIGIN;
  if (init.token !== null) headers.authorization = `Bearer ${init.token ?? TOKEN}`;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: init.method ?? "GET", headers, body: init.body });
  return { status: res.status, headers: res.headers, text: await res.text() };
};

beforeAll(async () => {
  harness = createServer((req, res) => {
    harnessHits += 1;
    res.writeHead(200, {
      "content-type": "application/json",
      // A harness that ever answered CORS itself must not widen the sidecar's.
      "access-control-allow-origin": "*",
      "access-control-allow-credentials": "true",
    });
    res.end(JSON.stringify({ bots: [] }));
  });
  const harnessPort = await listen(harness);
  const proxy = createProxyHandler({
    harnessPort,
    authenticate: (t) =>
      t === TOKEN ? { id: "phone-1", cloudDesktopAccess: true }
        : t === WEB_TOKEN ? { id: "browser-1", cloudDesktopAccess: false, web: true }
        : null,
    redeem: (_code, _name, _id, scope) => {
      lastScope = scope;
      return { error: "no pairing in progress" };
    },
    serverName: () => "Test computer",
    endpoints: () => [],
    status: () => companionStatusSnapshot(null, { hosted: "off", keepAwake: false }),
  });
  hosted = createServer((req, res) => proxy(req, res, "hosted"));
  hosted.on("upgrade", proxy.upgrade);
  device = createServer(proxy);
  device.on("upgrade", proxy.upgrade);
  hostedPort = await listen(hosted);
  devicePort = await listen(device);
});

afterAll(async () => {
  await close(hosted);
  await close(device);
  await close(harness);
});

describe("the hosted listener and the web companion origin", () => {
  it("forwards a token-bearing request and answers with exact-origin CORS", async () => {
    const before = harnessHits;
    const { status, headers } = await ask(hostedPort, "/api/bots?messages=1");
    expect(status).toBe(200);
    expect(harnessHits).toBe(before + 1);
    expect(headers.get("access-control-allow-origin")).toBe(WEB_COMPANION_ORIGIN);
    expect(headers.get("access-control-allow-credentials")).toBeNull();
    expect(headers.get("vary")).toContain("Origin");
    expect(headers.get("cache-control")).toContain("no-store");
  });

  it("still needs the device token", async () => {
    const before = harnessHits;
    const missing = await ask(hostedPort, "/api/bots", { token: null });
    const wrong = await ask(hostedPort, "/api/bots", { token: "omb_wrong" });
    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(harnessHits).toBe(before);
    // readable by the page so it can ask the person to pair again
    expect(missing.headers.get("access-control-allow-origin")).toBe(WEB_COMPANION_ORIGIN);
  });

  it("lets the page pair without a token, and check liveness", async () => {
    const pair = await ask(hostedPort, "/api/pair", { method: "POST", token: null, body: JSON.stringify({ code: "123456", deviceName: "x" }) });
    expect(pair.status).toBe(401);
    expect(pair.text).toContain("no pairing in progress");
    expect(pair.headers.get("access-control-allow-origin")).toBe(WEB_COMPANION_ORIGIN);
    expect((await ask(hostedPort, "/api/health", { token: null })).headers.get("access-control-allow-origin")).toBe(WEB_COMPANION_ORIGIN);
  });

  it("answers a preflight only for routes in the web subset", async () => {
    const ok = await ask(hostedPort, "/api/bots/b1/messages", {
      method: "OPTIONS",
      token: null,
      headers: { "access-control-request-method": "POST", "access-control-request-headers": "authorization, content-type" },
    });
    expect(ok.status).toBe(204);
    expect(ok.headers.get("access-control-allow-origin")).toBe(WEB_COMPANION_ORIGIN);
    expect(ok.headers.get("access-control-allow-methods")).toBe("POST");
    expect(ok.headers.get("access-control-allow-headers")).toBe("authorization, content-type, last-event-id");
    expect(ok.headers.get("access-control-allow-credentials")).toBeNull();

    for (const [method, path] of [
      ["POST", "/api/files"],
      ["DELETE", "/api/bots/b1"],
      ["PATCH", "/api/settings"],
      ["POST", "/api/bots/b1/computer/click"],
      ["GET", "/vps-viewer/abc"],
    ]) {
      const denied = await ask(hostedPort, path, { method: "OPTIONS", token: null, headers: { "access-control-request-method": method } });
      expect(denied.status, `${method} ${path}`).toBe(403);
      expect(denied.headers.get("access-control-allow-origin")).toBeNull();
    }
    const bare = await ask(hostedPort, "/api/bots", { method: "OPTIONS", token: null });
    expect(bare.status).toBe(403);
  });

  it("refuses native-only routes to a browser even with a valid token", async () => {
    const before = harnessHits;
    for (const [method, path] of [
      ["GET", "/vps-viewer/abc"],
      ["POST", "/api/files"],
      ["GET", "/api/bots/b1/computer/screenshot"],
    ]) {
      const res = await ask(hostedPort, path, { method });
      expect(res.status, `${method} ${path}`).toBeGreaterThanOrEqual(400);
    }
    expect(harnessHits).toBe(before);
  });

  it("refuses every other origin, and a lookalike", async () => {
    for (const origin of [
      "https://evil.example",
      "http://app.bosbot.my",
      "https://app.bosbot.my.evil.example",
      "https://x.app.bosbot.my",
      "https://app.bosbot.my:8443",
      "null",
    ]) {
      const res = await ask(hostedPort, "/api/bots", { origin });
      expect(res.status, origin).toBe(403);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    }
  });

  it("refuses websocket upgrades from a browser", async () => {
    const { request } = await import("node:http");
    const status = await new Promise<string>((resolve) => {
      const req = request({
        host: "127.0.0.1",
        port: hostedPort,
        path: "/vps-viewer/abc",
        headers: { connection: "Upgrade", upgrade: "websocket", origin: WEB_COMPANION_ORIGIN, authorization: `Bearer ${TOKEN}` },
      });
      req.on("upgrade", () => resolve("upgraded"));
      req.on("response", (res) => resolve(`http ${res.statusCode}`));
      req.on("error", () => resolve("closed"));
      req.end();
    });
    expect(status).not.toBe("upgraded");
  });
});

describe("a device paired from the browser", () => {
  it("is paired as a web device only when the web origin asked", async () => {
    await ask(hostedPort, "/api/pair", { method: "POST", token: null, body: JSON.stringify({ code: "123456" }) });
    expect(lastScope).toBe("web");
    await ask(hostedPort, "/api/pair", { method: "POST", token: null, origin: null, body: JSON.stringify({ code: "123456" }) });
    expect(lastScope).toBe("native");
  });

  it("keeps the web subset when its token is replayed without an Origin", async () => {
    const before = harnessHits;
    for (const port of [hostedPort, devicePort]) {
      expect((await ask(port, "/api/files", { method: "POST", origin: null, token: WEB_TOKEN, body: "{}" })).status).toBeGreaterThanOrEqual(400);
      expect((await ask(port, "/api/bots/b1/always-allow", { method: "POST", origin: null, token: WEB_TOKEN, body: "{}" })).status).toBeGreaterThanOrEqual(400);
      expect((await ask(port, "/vps-viewer/abc", { origin: null, token: WEB_TOKEN })).status).toBe(404);
    }
    expect(harnessHits).toBe(before);
    // chat still works for it
    expect((await ask(devicePort, "/api/bots", { origin: null, token: WEB_TOKEN })).status).toBe(200);
  });

  it("can't open a websocket even without an Origin", async () => {
    const { request } = await import("node:http");
    const status = await new Promise<string>((resolve) => {
      const req = request({
        host: "127.0.0.1",
        port: devicePort,
        path: "/vps-viewer/abc",
        headers: { connection: "Upgrade", upgrade: "websocket", authorization: `Bearer ${WEB_TOKEN}` },
      });
      req.on("upgrade", () => resolve("upgraded"));
      req.on("response", (res) => resolve(`http ${res.statusCode}`));
      req.on("error", () => resolve("closed"));
      req.end();
    });
    expect(status).toBe("closed");
  });
});

describe("the LAN/tailnet listener", () => {
  it("refuses the web companion origin too — browsers only ever use the hosted route", async () => {
    const before = harnessHits;
    const res = await ask(devicePort, "/api/bots");
    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    const pre = await ask(devicePort, "/api/bots", { method: "OPTIONS", token: null, headers: { "access-control-request-method": "GET" } });
    expect(pre.status).toBe(403);
    expect(harnessHits).toBe(before);
  });

  it("still serves a native app that sends no origin", async () => {
    expect((await ask(devicePort, "/api/bots", { origin: null })).status).toBe(200);
  });
});
