import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compareVersions, createEnterpriseBuilder, createStandaloneExecutor, feedKey, verifyManifest, type FeedManifest } from "./enterprise-update.ts";
import type { ExecutorPlan } from "./updater.ts";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const key = feedKey(publicKey.export({ type: "spki", format: "der" }).toString("base64"));
const OLD = "a".repeat(40), NEW = "b".repeat(40);
const dirs: string[] = [];
const temp = () => { const d = mkdtempSync(join(tmpdir(), "bos-ent-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function bundle(commit = NEW): Buffer {
  const src = temp();
  mkdirSync(join(src, "server"), { recursive: true }); mkdirSync(join(src, "ui")); mkdirSync(join(src, "skills"));
  writeFileSync(join(src, "server", "index.js"), "// server\n");
  writeFileSync(join(src, "ui", "index.html"), "<html></html>\n");
  writeFileSync(join(src, "build-commit.json"), JSON.stringify({ commit }));
  const out = join(temp(), "b.tgz");
  execFileSync("tar", ["-czf", out, "-C", src, "."]);
  return readFileSync(out);
}

function feed(files: { manifest: Partial<FeedManifest>; archive?: Buffer; signWith?: typeof privateKey; tamper?: boolean }) {
  const archive = files.archive ?? bundle(files.manifest.commit ?? NEW);
  const manifest: FeedManifest = {
    schema: 1, channel: "enterprise", version: "2.0.3", commit: NEW, publishedAt: "2026-10-15T00:00:00.000Z",
    bundle: { file: "bundle-bbbbbbbb.tgz", sha256: createHash("sha256").update(archive).digest("hex"), size: archive.length },
    ...files.manifest,
  } as FeedManifest;
  const body = Buffer.from(JSON.stringify(manifest));
  const sig = sign(null, body, files.signWith ?? privateKey).toString("base64");
  const served: Record<string, Buffer> = { "manifest.json": files.tamper ? Buffer.from(JSON.stringify({ ...manifest, version: "9.9.9" })) : body, "manifest.sig": Buffer.from(sig), [manifest.bundle.file]: archive };
  const fetchMock = vi.fn(async (url: string | URL) => {
    const name = String(url).split("/").pop()!;
    const data = served[name];
    return data ? new Response(new Uint8Array(data)) : new Response("missing", { status: 404 });
  });
  return { fetch: fetchMock as unknown as typeof fetch, manifest };
}

describe("enterprise feed", () => {
  it("compares versions on the numeric core", () => {
    expect(compareVersions("2.0.2", "2.0.10")).toBe(-1);
    expect(compareVersions("2.1.0", "2.0.9")).toBe(1);
    expect(compareVersions("2.0.2+abc", "2.0.2")).toBe(0);
    expect(compareVersions("2.1.0-beta", "2.1.0")).toBe(-1);
    expect(compareVersions("2.1.0", "2.1.0-beta.2")).toBe(1);
  });

  it("only believes manifests our key signed", () => {
    const body = Buffer.from(JSON.stringify({ schema: 1 }));
    const other = generateKeyPairSync("ed25519").privateKey;
    expect(() => verifyManifest(body, sign(null, body, other).toString("base64"), key)).toThrow(/signature/);
    expect(() => verifyManifest(body, sign(null, body, privateKey).toString("base64"), key)).toThrow(/malformed/);
  });

  it("reports up to date, an update, a downgrade and a replay", async () => {
    const dir = temp();
    const current = { version: "2.0.2", sha: OLD };
    const at = (f: ReturnType<typeof feed>) => createEnterpriseBuilder({ feed: "https://feed.test/updates/enterprise/", standaloneDir: dir, current: () => current, key, fetch: f.fetch });

    expect((await at(feed({ manifest: { commit: OLD } })).check()).upToDate).toBe(true);
    const found = await at(feed({ manifest: {} })).check();
    expect(found.candidate).toMatchObject({ version: "2.0.3", sha: NEW, branch: "enterprise" });
    expect((await at(feed({ manifest: { version: "2.0.1" } })).check()).reason).toMatch(/older than the running/);

    mkdirSync(join(dir, "updates"), { recursive: true });
    writeFileSync(join(dir, "updates", "feed-state.json"), JSON.stringify({ publishedAt: "2026-10-16T00:00:00.000Z" }));
    expect((await at(feed({ manifest: {} })).check()).reason).toMatch(/older than the installed one/);
  });

  it("refuses a manifest signed for another channel", async () => {
    const current = { version: "2.0.2", sha: OLD };
    const builder = createEnterpriseBuilder({ feed: "https://feed.test/e", standaloneDir: temp(), current: () => current, key, fetch: feed({ manifest: { channel: "beta" } }).fetch });
    expect((await builder.check()).reason).toMatch(/beta channel/);
  });

  it("refuses a tampered manifest", async () => {
    const builder = createEnterpriseBuilder({ feed: "https://feed.test/e", standaloneDir: temp(), current: () => ({ version: "2.0.2", sha: OLD }), key, fetch: feed({ manifest: {}, tamper: true }).fetch });
    await expect(builder.check()).rejects.toThrow(/signature/);
  });

  it("downloads, verifies and stages the bundle", async () => {
    const dir = temp();
    const f = feed({ manifest: {} });
    const builder = createEnterpriseBuilder({ feed: "https://feed.test/e", standaloneDir: dir, current: () => ({ version: "2.0.2", sha: OLD }), key, fetch: f.fetch });
    const lines: string[] = [];
    await builder.build({ version: "2.0.3", sha: NEW, branch: "enterprise" }, line => lines.push(line));
    expect(existsSync(join(dir, "updates", "staged", "server", "index.js"))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "updates", "staged", "staged.json"), "utf8"))).toMatchObject({ version: "2.0.3", sha: NEW, publishedAt: f.manifest.publishedAt });
    expect(lines.at(-1)).toMatch(/staged 2.0.3/);

    const executor = createStandaloneExecutor({ standaloneDir: dir, port: 1, supervised: true, quit: () => undefined });
    expect(await executor.candidate()).toMatchObject({ version: "2.0.3", sha: NEW });
  });

  it("refuses a bundle that does not match the signed hash", async () => {
    const dir = temp();
    const good = bundle();
    const f = feed({ manifest: { bundle: { file: "bundle-bbbbbbbb.tgz", sha256: "0".repeat(64), size: good.length } }, archive: good });
    const builder = createEnterpriseBuilder({ feed: "https://feed.test/e", standaloneDir: dir, current: () => ({ version: "2.0.2", sha: OLD }), key, fetch: f.fetch });
    await expect(builder.build({ version: "2.0.3", sha: NEW, branch: "enterprise" }, () => undefined)).rejects.toThrow(/does not match the signed manifest/);
    expect(existsSync(join(dir, "updates", "staged"))).toBe(false);
  });

  it("refuses a bundle whose build stamp disagrees with the manifest", async () => {
    const dir = temp();
    const f = feed({ manifest: {}, archive: bundle(OLD) });
    const builder = createEnterpriseBuilder({ feed: "https://feed.test/e", standaloneDir: dir, current: () => ({ version: "2.0.2", sha: "c".repeat(40) }), key, fetch: f.fetch });
    await expect(builder.build({ version: "2.0.3", sha: NEW, branch: "enterprise" }, () => undefined)).rejects.toThrow(/build-commit.json says/);
  });
});

describe("standalone executor", () => {
  it("refuses when no launcher supervises the server", async () => {
    const executor = createStandaloneExecutor({ standaloneDir: temp(), port: 1, supervised: false, quit: () => undefined });
    await expect(executor.admit("restart")).rejects.toThrow(/launcher/);
  });

  it("hands off through request.json, then quits", async () => {
    vi.useFakeTimers();
    try {
      const dir = temp();
      const quit = vi.fn();
      const executor = createStandaloneExecutor({ standaloneDir: dir, port: 38799, supervised: true, quit });
      expect(await executor.admit("restart")).toEqual([]);
      await expect(executor.admit("update")).rejects.toThrow(/no staged update/);
      expect(await executor.ports()).toEqual([38799]);
      await executor.execute({ updateId: "u1", mode: "restart" } as ExecutorPlan, join(dir, "job"));
      expect(JSON.parse(readFileSync(join(dir, "updates", "request.json"), "utf8"))).toMatchObject({ updateId: "u1", mode: "restart", plan: join(dir, "job", "plan.json") });
      expect(quit).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1000);
      expect(quit).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
});
