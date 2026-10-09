import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestWelcome, WELCOME_URL, welcomeInstallId, welcomeName } from "./welcome-chat.ts";

const ID = "3f2b6c1e-8a4d-4b7e-9c2a-1d5e6f7a8b9c";
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "welcome-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const reply = (status: number, body: unknown = {}) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

describe("welcomeInstallId", () => {
  it("reuses the usage ping's install id", async () => {
    await writeFile(join(dir, "anonymous-usage.json"), JSON.stringify({ install_id: ID, last_attempt_at: 5 }));
    expect(await welcomeInstallId(dir)).toBe(ID);
  });

  it("mints one the ping will keep when the ping has not run", async () => {
    const id = await welcomeInstallId(dir);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(await readFile(join(dir, "anonymous-usage.json"), "utf8"))).toEqual({ install_id: id });
    expect(await welcomeInstallId(dir)).toBe(id);
  });

  it("never replaces a corrupt record", async () => {
    await writeFile(join(dir, "anonymous-usage.json"), "{nope");
    await expect(welcomeInstallId(dir)).rejects.toMatchObject({ status: 503 });
    expect(await readFile(join(dir, "anonymous-usage.json"), "utf8")).toBe("{nope");
  });
});

describe("welcomeName", () => {
  it("accepts 1 to 40 characters after trimming", () => {
    expect(welcomeName("  Putri   Ayu ")).toBe("Putri Ayu");
    expect(welcomeName("")).toBeNull();
    expect(welcomeName("   ")).toBeNull();
    expect(welcomeName("x".repeat(41))).toBeNull();
    expect(welcomeName(7)).toBeNull();
  });
});

describe("requestWelcome", () => {
  const body = { installId: ID, name: "Putri" };

  it("posts the frozen body and returns the guest link", async () => {
    const fetch = reply(201, { url: "https://hi.bos.aihlete.com/pair#code=abc", expiresAt: "2026-10-09T13:00:00.000Z" });
    expect(await requestWelcome(body, { fetch, env: {} })).toEqual({
      status: 201, url: "https://hi.bos.aihlete.com/pair#code=abc", expiresAt: "2026-10-09T13:00:00.000Z",
    });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(WELCOME_URL);
    expect(init).toMatchObject({ method: "POST", credentials: "omit", redirect: "error" });
    expect(JSON.parse(String(init.body))).toEqual(body);
  });

  it("passes 429 through as try later", async () => {
    expect(await requestWelcome(body, { fetch: reply(429), env: {} })).toMatchObject({ status: 429 });
  });

  it("reads 503, other statuses, network errors and bad links as offline", async () => {
    const offline = { status: 503 };
    expect(await requestWelcome(body, { fetch: reply(503, { error: "down" }), env: {} })).toMatchObject(offline);
    expect(await requestWelcome(body, { fetch: reply(404), env: {} })).toMatchObject(offline);
    expect(await requestWelcome(body, { fetch: vi.fn(async () => { throw new Error("offline"); }), env: {} })).toMatchObject(offline);
    for (const url of ["https://evil.test/pair", "http://hi.bos.aihlete.com/pair", "https://bos.aihlete.com.evil.test/x"]) {
      expect(await requestWelcome(body, { fetch: reply(201, { url, expiresAt: "2026-10-09T13:00:00.000Z" }), env: {} })).toMatchObject(offline);
    }
    expect(await requestWelcome(body, { fetch: reply(201, { url: "https://hi.bos.aihlete.com/pair" }), env: {} })).toMatchObject(offline);
  });

  it("stubs a link without calling out when BOS_WELCOME_STUB=1", async () => {
    const fetch = reply(500);
    const result = await requestWelcome(body, { fetch, env: { BOS_WELCOME_STUB: "1" }, now: () => 0 });
    expect(result).toEqual({ status: 201, url: "https://hi.bos.aihlete.com/pair#code=stub-3f2b6c1e", expiresAt: "1970-01-01T00:15:00.000Z" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
