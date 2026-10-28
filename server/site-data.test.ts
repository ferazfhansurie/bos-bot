import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createSiteData, siteDataTokenFile, withoutPeople } from "./site-data.ts";

const token = "t".repeat(32);
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
let dir = "";
let file = "";
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "site-data-")); file = join(dir, "token"); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

it("is not available without a token file, and never calls the site", async () => {
  const f = vi.fn();
  const site = createSiteData({ tokenFile: () => file, fetch: f });
  expect(await site.available()).toBe(false);
  expect(await site.read()).toBeNull();
  await writeFile(file, "short\n");
  expect(await site.available()).toBe(false);
  expect(f).not.toHaveBeenCalled();
});

it("sends the token only to the site and keeps it out of the answer", async () => {
  await writeFile(file, token + "\n");
  const f = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => json({ health: { overall: "good" } }));
  const site = createSiteData({ tokenFile: () => file, url: "https://bosbot.my/data/api", fetch: f });
  expect(await site.available()).toBe(true);
  const read = await site.read();
  expect(read?.data).toEqual({ health: { overall: "good" } });
  expect(f.mock.calls[0]![0]).toBe("https://bosbot.my/data/api");
  expect(f.mock.calls[0]![1]).toMatchObject({ credentials: "omit", redirect: "error", headers: { authorization: `Bearer ${token}` } });
  expect(JSON.stringify(read)).not.toContain(token);
});

it("caches for a minute and lets a pull refresh after ten seconds", async () => {
  await writeFile(file, token);
  let t = 1_000_000;
  const f = vi.fn(async () => json({ n: t }));
  const site = createSiteData({ tokenFile: () => file, fetch: f, now: () => t });
  await Promise.all([site.read(), site.read()]);
  expect(f).toHaveBeenCalledTimes(1);
  t += 5_000;
  await site.read({ fresh: true });
  expect(f).toHaveBeenCalledTimes(1);
  t += 6_000;
  await site.read();
  expect(f).toHaveBeenCalledTimes(1);
  await site.read({ fresh: true });
  expect(f).toHaveBeenCalledTimes(2);
  t += 61_000;
  await site.read();
  expect(f).toHaveBeenCalledTimes(3);
});

it("names a refused token and an unreachable site", async () => {
  await writeFile(file, token);
  await expect(createSiteData({ tokenFile: () => file, fetch: vi.fn().mockResolvedValue(json({}, 401)) }).read()).rejects.toThrow("refused");
  await expect(createSiteData({ tokenFile: () => file, fetch: vi.fn().mockRejectedValue(new Error("offline")) }).read()).rejects.toThrow("Could not reach");
  await expect(createSiteData({ tokenFile: () => file, fetch: vi.fn().mockResolvedValue(new Response("[1]")) }).read()).rejects.toThrow("unreadable");
});

it("drops people's contact details before anything reaches the phone", () => {
  const out = withoutPeople({
    who: [{ email: "a@b.c", whatsapp: "601" }],
    box: { account: { email: "owner@x.y" }, sandboxes: [{ name: "pool", email: "p@q.r" }], balance: { available: 1 } },
    ads: { spent_rm: 2 },
  });
  expect(out).toEqual({ box: { sandboxes: [{ name: "pool" }], balance: { available: 1 } }, ads: { spent_rm: 2 } });
});

it("reads the token path from the environment, with a neutral default", () => {
  expect(siteDataTokenFile({ BOS_SITE_DATA_TOKEN_FILE: "/x/token" })).toBe("/x/token");
  expect(siteDataTokenFile({})).toMatch(/\.config\/bosbot\/site-data-token$/);
});
