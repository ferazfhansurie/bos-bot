import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProductTelemetry } from "./product-telemetry.ts";
import { AnonymousUsagePing } from "./anonymous-usage-ping.ts";

let dataDir: string;
let enabled: boolean;
let env: NodeJS.ProcessEnv;
let bodies: Array<Record<string, any>>;
let telemetry: ProductTelemetry;
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "bos-product-")); enabled = true; env = {}; bodies = [];
  telemetry = create();
});
afterEach(async () => { await telemetry.stop(); await rm(dataDir, { recursive: true, force: true }); vi.useRealTimers(); });
function create(transport: typeof fetch = vi.fn(async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return Response.json({ ok: true }); })) {
  return new ProductTelemetry({ dataDir, enabled: () => enabled, env, version: () => "2.1.3", platform: "darwin", fetch: transport });
}
it("batches at most fifty content-free events and shares the daily ping identity", async () => {
  for (let i = 0; i < 55; i++) telemetry.track("message_sent", { count: i, prompt: "private" });
  await telemetry.flush(); await telemetry.flush();
  expect(bodies.map(body => body.events.length)).toEqual([50, 5]);
  const id = bodies[0].install_id;
  expect(bodies[0]).toMatchObject({ version: "2.1.3", platform: "darwin" });
  expect(JSON.stringify(bodies)).not.toContain("private");
  const ping = new AnonymousUsagePing({ dataDir, env, enabled: () => enabled, version: () => "2.1.3",
    counts: () => ({ engines: [], bots: 0, rooms: 0, room_bots_max: 0, room_humans_max: 0 }),
    fetch: vi.fn(async (_url, init) => { expect(JSON.parse(String(init?.body)).install_id).toBe(id); return Response.json({ ok: true }); }) });
  await ping.tick(); ping.stop();
  expect((await stat(join(dataDir, "product-events.json"))).mode & 0o777).toBe(0o600);
});
it("preserves first-event dedupe and failed queue across restarts", async () => {
  telemetry = create(vi.fn(async () => { throw Error("offline"); }));
  telemetry.track("first_message"); telemetry.track("first_message");
  await telemetry.flush();
  telemetry = create();
  telemetry.track("first_message"); await telemetry.flush();
  expect(bodies[0].events.map((event: { name: string }) => event.name)).toEqual(["first_message"]);
});
it("honors both optouts without an identity and clears queued events on optout", async () => {
  enabled = false; telemetry.track("open"); await telemetry.flush();
  await expect(readFile(join(dataDir, "anonymous-usage.json"))).rejects.toMatchObject({ code: "ENOENT" });
  enabled = true; env.BOS_NO_PING = "1"; telemetry.track("open"); await telemetry.flush();
  expect(bodies).toHaveLength(0);
  delete env.BOS_NO_PING; telemetry.track("open"); enabled = false; telemetry.settingsChanged(); enabled = true;
  await telemetry.flush(); expect(bodies).toHaveLength(0);
});
it("fails closed on corrupt identity rather than inventing an install", async () => {
  await writeFile(join(dataDir, "anonymous-usage.json"), "bad");
  telemetry.track("open"); await telemetry.flush(); expect(bodies).toHaveLength(0);
});
it("flushes every sixty seconds and on stop", async () => {
  vi.useFakeTimers(); telemetry.start(); telemetry.track("engine_connected", { engine: "claude" });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(bodies.some(body => body.events.some((event: {name: string}) => event.name === "engine_connected"))).toBe(true);
  telemetry.track("error", { class: "network" }); await telemetry.stop();
  expect(bodies.at(-1)?.events[0].name).toBe("error");
});
it("times the first message from the install, across restarts, and never guesses for older installs", async () => {
  let now = 1_000_000;
  const at = (transport?: typeof fetch) => new ProductTelemetry({ dataDir, enabled: () => enabled, env, version: () => "3.0.0", platform: "darwin", now: () => now,
    fetch: transport ?? vi.fn(async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return Response.json({ ok: true }); }) });
  telemetry = at(); telemetry.track("install"); await telemetry.flush();
  now += 42_000; telemetry = at(); telemetry.track("first_message", { v3: true }); await telemetry.flush();
  expect(bodies.at(-1)?.events).toEqual([expect.objectContaining({ name: "first_message", props: { v3: true, duration_ms: 42_000 } })]);
  await rm(dataDir, { recursive: true, force: true }); bodies = [];
  dataDir = await mkdtemp(join(tmpdir(), "bos-product-"));
  await writeFile(join(dataDir, "product-events.json"), JSON.stringify({ seen: ["install"], queue: [] }));
  telemetry = at(); telemetry.track("first_message", { v3: true }); await telemetry.flush();
  expect(bodies.at(-1)?.events[0].props).toEqual({ v3: true });
});
it("adds no timing when 3.0 is off, and clamps a very slow first message", async () => {
  let now = 1_000_000;
  const at = () => new ProductTelemetry({ dataDir, enabled: () => enabled, env, version: () => "2.2.1", platform: "darwin", now: () => now,
    fetch: vi.fn(async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return Response.json({ ok: true }); }) });
  telemetry = at(); telemetry.track("install"); await telemetry.flush();
  now += 30 * 86_400_000; telemetry = at(); telemetry.track("first_message"); await telemetry.flush();
  expect(bodies.at(-1)?.events[0].props).toEqual({});
  await writeFile(join(dataDir, "product-events.json"), JSON.stringify({ seen: ["install"], queue: [], installedAt: 1_000_000 }));
  telemetry = at(); telemetry.track("first_message", { v3: true }); await telemetry.flush();
  expect(bodies.at(-1)?.events[0].props).toEqual({ v3: true, duration_ms: 1_000_000_000 });
});
