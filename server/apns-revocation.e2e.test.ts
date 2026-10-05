import { createServer } from "node:http";
import { readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";
it("session revocation removes owned push registration and linked homes never broaden device authority", async () => {
 let forwardedPushes = 0;
 const remote = createServer((req, res) => { if (req.url === "/api/multiplayer/push-token") forwardedPushes++; res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ registered: true })); });
 await new Promise<void>(resolve => remote.listen(0, "127.0.0.1", resolve));
 const address = remote.address() as { port: number };
 const session = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, undefined, [], undefined, { origin: `http://127.0.0.1:${address.port}`, prepare: dataDir => {
  writeFileSync(join(dataDir, "multiplayer-links.json"), JSON.stringify({ version: 1, links: [{ homeId: "remote", origin: "https://delegated-fixture.example.ts.net:8443", name: "fixture", token: `omb_sess_${"x".repeat(43)}`, bots: [], proxyGroups: {} }], primary: { homeId: "remote", actorId: "remote:person:owner" } }));
 } });
 const api = async (path: string, body?: unknown, token?: string, method = "POST") => {
  const response = await fetch(`${session.info.url}${path}`, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json() as any };
 };
 try {
  const payload = { token: "a".repeat(64), environment: "development", connectionId: "fixture-home" };
  expect((await api("/api/multiplayer/push-token", payload)).status).toBe(403);
  expect(forwardedPushes).toBe(0);
  const pairing = await api("/api/auth/pairing", { scopes: ["client"] });
  const paired = await api("/api/auth/pair", { code: pairing.body.code, label: "fixture device" });
  await api("/api/multiplayer/actor-bindings", { sessionId: paired.body.session.id, personId: "remote:person:owner", name: "fixture owner" });
  const registered = await api("/api/multiplayer/push-token", payload, paired.body.token);
  expect(registered.status).toBe(200); expect(registered.body).toMatchObject({ registered: true, remoteRegistered: false, deliveryScope: "local" });
  expect(forwardedPushes).toBe(0);
  const registry = join(session.info.dataDir, "apns-devices.json");
  expect(JSON.parse(readFileSync(registry, "utf8")).devices[0].sessionId).toBe(paired.body.session.id);
  await api(`/api/auth/sessions/${paired.body.session.id}`, {}, undefined, "DELETE");
  expect(JSON.parse(readFileSync(registry, "utf8")).devices).toEqual([]);
  expect((await api("/api/multiplayer/push-token", payload, paired.body.token)).status).toBe(401);
  const secondPairing = await api("/api/auth/pairing", { scopes: ["client"] });
  const second = await api("/api/auth/pair", { code: secondPairing.body.code, label: "fixture device two" });
  await api("/api/multiplayer/actor-bindings", { sessionId: second.body.session.id, personId: "remote:person:owner", name: "fixture owner" });
  expect((await api("/api/multiplayer/push-token", payload, second.body.token)).status).toBe(200);
  rmSync(registry); mkdirSync(registry);
  expect((await api(`/api/auth/sessions/${second.body.session.id}`, {}, undefined, "DELETE")).status).toBe(200);
  expect(JSON.parse(readFileSync(join(session.info.dataDir, "sessions.json"), "utf8")).sessions.some((entry: any) => entry.id === second.body.session.id)).toBe(false);

 } finally { await session.close(); await new Promise<void>(resolve => remote.close(() => resolve())); }
}, 45_000);
