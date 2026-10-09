import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnonymousUsagePing, usageRoomCounts, USAGE_PING_INTERVAL_MS, USAGE_PING_URL } from "./anonymous-usage-ping.ts";
import { parseConfigPatch, parseStoredConfig, providerReloadKeys } from "./config.ts";

describe("anonymous usage ping", () => {
  let dataDir: string;
  let now: number;
  let enabled: boolean;
  let env: NodeJS.ProcessEnv;
  let requests: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }>;
  let transport: typeof fetch;
  const senders: AnonymousUsagePing[] = [];
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "bos-ping-"));
    now = 1_800_000_000_000;
    enabled = true;
    env = {};
    requests = [];
    transport = vi.fn(async (url, init) => {
      requests.push({ url: String(url), init: init!, body: JSON.parse(String(init?.body)) });
      return new Response(null, { status: 204 });
    });
  });
  afterEach(async () => {
    senders.splice(0).forEach(sender => sender.stop());
    vi.useRealTimers();
    await rm(dataDir, { recursive: true, force: true });
  });
  function sender(fetcher = transport) {
    const ping = new AnonymousUsagePing({ dataDir, env, enabled: () => enabled, now: () => now,
      platform: "win32", arch: "x64", version: () => "1.9.2", fetch: fetcher,
      counts: () => ({ engines: ["codex", "claude", "claude", "/secret/engine", "token"],
        bots: 3, ...usageRoomCounts([{ humans: 2, bots: 4 }, { humans: 1, bots: 1 }]),
        name: "private", email: "private@example.com", message: "private", token: "private" }),
    });
    senders.push(ping);
    return ping;
  }
  it("sends the frozen first_run body and one daily ping per rolling 24h across restarts", async () => {
    const ping = sender();
    await Promise.all([ping.tick(), ping.tick()]);
    expect(requests).toHaveLength(1);
    const id = requests[0].body.install_id;
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(requests[0].body).toEqual({ install_id: id, version: "1.9.2", platform: "win32", arch: "x64",
      engines: ["claude", "codex"], bots: 3, rooms: 2, room_humans_max: 2, room_bots_max: 4, event: "first_run" });
    expect(requests[0].url).toBe(USAGE_PING_URL);
    expect(requests[0].init).toMatchObject({ method: "POST", headers: { "content-type": "application/json" },
      credentials: "omit", redirect: "error" });
    ping.stop();
    const restarted = sender();
    now += USAGE_PING_INTERVAL_MS - 1;
    await restarted.tick();
    expect(requests).toHaveLength(1);
    now++;
    await restarted.tick();
    expect(requests).toHaveLength(2);
    expect(requests[1].body).toEqual({ ...requests[0].body, event: "daily" });
    await restarted.tick();
    expect(requests).toHaveLength(2);
  });
  it("honors both opt-outs without creating an id and preserves the id when reenabled", async () => {
    const ping = sender();
    enabled = false;
    await ping.tick();
    enabled = true;
    env.BOS_NO_PING = "1";
    await ping.tick();
    expect(requests).toHaveLength(0);
    await expect(readFile(join(dataDir, "anonymous-usage.json"))).rejects.toMatchObject({ code: "ENOENT" });
    delete env.BOS_NO_PING;
    await ping.tick();
    const id = requests[0].body.install_id;
    enabled = false;
    now += USAGE_PING_INTERVAL_MS;
    await ping.tick();
    expect(requests).toHaveLength(1);
    enabled = true;
    await ping.tick();
    expect(requests[1].body.install_id).toBe(id);
  });
  it.each(["offline", "bad body"])("silently caps attempts after %s receiver failures", async failure => {
    const fetcher: typeof fetch = vi.fn(async () => {
      if (failure === "offline") throw new Error("offline");
      return new Response("bad body", { status: 400 });
    });
    await expect(sender(fetcher).tick()).resolves.toBeUndefined();
    await sender(fetcher).tick();
    expect(fetcher).toHaveBeenCalledTimes(1);
    now += USAGE_PING_INTERVAL_MS;
    await sender(fetcher).tick();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each(["timeout", "opt-out"])("aborts an in-flight request on %s without blocking startup", async reason => {
    vi.useFakeTimers();
    let received!: () => void;
    const ready = new Promise<void>(resolve => { received = resolve; });
    let signal: AbortSignal | undefined;
    const fetcher: typeof fetch = vi.fn((_url, init) => new Promise<Response>((_resolve, reject) => {
      const requestSignal = init!.signal!;
      signal = requestSignal;
      requestSignal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      received();
    }));
    const ping = sender(fetcher);
    expect(ping.start()).toBeUndefined();
    await ready;
    await ping.tick(); // overlapping call returns while transport is pending
    expect(fetcher).toHaveBeenCalledTimes(1);
    if (reason === "timeout") {
      await vi.advanceTimersByTimeAsync(4_999);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
    } else {
      enabled = false;
      ping.settingsChanged();
    }
    expect(signal?.aborted).toBe(true);
  });
  it("fails closed on corrupt durable state and a backwards clock", async () => {
    const file = join(dataDir, "anonymous-usage.json");
    await writeFile(file, "broken");
    await sender().tick();
    expect(requests).toHaveLength(0);
    await rm(file);
    await sender().tick();
    now--;
    await sender().tick();
    expect(requests).toHaveLength(1);
  });
  it("validates the persisted setting and does not reload provider engines", () => {
    const patch = { anonymousUsage: { enabled: false } };
    expect(parseConfigPatch(patch)).toEqual(patch);
    expect(parseStoredConfig(patch)).toEqual(patch);
    expect(providerReloadKeys(patch)).toEqual([]);
    expect(() => parseConfigPatch({ anonymousUsage: { enabled: "false" } })).toThrow();
    expect(() => parseConfigPatch({ anonymousUsage: { enabled: true, endpoint: "https://other.example" } })).toThrow();
  });
});
