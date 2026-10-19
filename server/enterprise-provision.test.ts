import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  applyEnterpriseSetup, isFreshWorkspace, nodeShimPath, refreshNodeShim, substitutePlaceholders, writeNodeShim,
} from "./enterprise-provision.ts";

const temps: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "omb-enterprise-")); temps.push(dir); return dir; };
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("substitutePlaceholders", () => {
  it("replaces both placeholders in every string, deeply, and leaves keys and other values alone", () => {
    const input = {
      "{{DATA_DIR}}": "key stays",
      command: "{{NODE}}",
      args: ["{{DATA_DIR}}/workspaces/b1/tools/studio-mcp.mjs", "--root={{DATA_DIR}}", 3, true, null],
      nested: { env: { HOME: "{{DATA_DIR}}/home", OTHER: "{{UNKNOWN}}" } },
    };
    const out = substitutePlaceholders(input, { dataDir: "/Users/c/.bos-bot", node: "/Users/c/.bos-bot/enterprise-runtime/node" });
    expect(out).toEqual({
      "{{DATA_DIR}}": "key stays",
      command: "/Users/c/.bos-bot/enterprise-runtime/node",
      args: ["/Users/c/.bos-bot/workspaces/b1/tools/studio-mcp.mjs", "--root=/Users/c/.bos-bot", 3, true, null],
      nested: { env: { HOME: "/Users/c/.bos-bot/home", OTHER: "{{UNKNOWN}}" } },
    });
    expect(input.command).toBe("{{NODE}}");
  });

  it("treats replacement text literally ($ patterns are not special)", () => {
    expect(substitutePlaceholders("{{DATA_DIR}}/x", { dataDir: "/a/$&/$1", node: "n" })).toBe("/a/$&/$1/x");
  });
});

describe("isFreshWorkspace", () => {
  const bos = { name: "BOS" };
  it("accepts an empty workspace and the seeded starter bot", () => {
    expect(isFreshWorkspace({ bots: [], rooms: 0, messages: 0, userMessages: 0 })).toBe(true);
    expect(isFreshWorkspace({ bots: [bos], rooms: 0, messages: 1, userMessages: 0 })).toBe(true);
    expect(isFreshWorkspace({ bots: [bos], rooms: 0, messages: 0, userMessages: 0 })).toBe(true);
  });
  it("refuses anything a person has used", () => {
    expect(isFreshWorkspace({ bots: [bos], rooms: 0, messages: 2, userMessages: 1 })).toBe(false);
    expect(isFreshWorkspace({ bots: [bos], rooms: 0, messages: 2, userMessages: 0 })).toBe(false);
    expect(isFreshWorkspace({ bots: [{ name: "Sales" }], rooms: 0, messages: 0, userMessages: 0 })).toBe(false);
    expect(isFreshWorkspace({ bots: [bos, { name: "BOS" }], rooms: 0, messages: 0, userMessages: 0 })).toBe(false);
    expect(isFreshWorkspace({ bots: [bos], rooms: 1, messages: 0, userMessages: 0 })).toBe(false);
    expect(isFreshWorkspace({ bots: [], rooms: 0, messages: 3, userMessages: 0 })).toBe(false);
  });
});

describe.skipIf(process.platform === "win32")("node shim", () => {
  it("runs the given executable as node, survives quotes in the path, and is refreshed only when present", () => {
    const dataDir = temp();
    expect(refreshNodeShim(dataDir, process.execPath)).toBeNull();
    expect(existsSync(nodeShimPath(dataDir))).toBe(false);
    const shim = writeNodeShim(dataDir, process.execPath);
    expect(shim).toBe(nodeShimPath(dataDir));
    expect(statSync(shim).mode & 0o777).toBe(0o755);
    const run = spawnSync(shim, ["-e", "process.stdout.write(process.env.ELECTRON_RUN_AS_NODE + ':' + process.version)"], { encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(`1:${process.version}`);
    expect(readFileSync(shim, "utf8")).toContain(`'${process.execPath}'`);
    writeNodeShim(dataDir, "/Apps/it's here/BOS");
    expect(readFileSync(shim, "utf8")).toContain(`'/Apps/it'\\''s here/BOS'`);
    expect(refreshNodeShim(dataDir, process.execPath)).toBe(shim);
    expect(readFileSync(shim, "utf8")).toContain(`'${process.execPath}'`);
    expect(lstatSync(shim).isFile()).toBe(true);
  });
});

describe("applyEnterpriseSetup", () => {
  const harness = (bots = [{ id: "b1", name: "Ops" }]) => {
    const calls: string[] = [];
    const seen: Record<string, unknown> = {};
    const dataDir = temp();
    return {
      calls, seen, dataDir,
      deps: {
        dataDir, execPath: process.execPath,
        workspace: () => ({ bots, rooms: 0, messages: 4, userMessages: 2 }),
        applyInstances: async (instances: unknown) => { calls.push("instances"); seen.instances = instances; },
        applyFeatures: (features: Record<string, boolean>) => { calls.push("features"); seen.features = features; },
        applyMcpServers: (servers: Record<string, unknown>) => { calls.push("mcp"); seen.mcp = servers; },
        parseMcpServer: (_name: string, raw: unknown) => ({ ok: true as const, server: raw }),
        applyBot: (id: string, patch: unknown) => { calls.push(`bot:${id}`); seen[id] = patch; return { ok: true as const }; },
      },
    };
  };
  const setup = {
    version: 1,
    features: { managedCodex: true },
    instances: { sol: { driver: "codex", displayName: "ChatGPT" } },
    mcpServers: { studio: { command: "{{NODE}}", args: ["{{DATA_DIR}}/workspaces/b1/tools/studio-mcp.mjs"], env: {}, enabled: true } },
    bots: { b1: { cwd: "{{DATA_DIR}}/workspaces/b1", modelSelection: { instanceId: "sol", model: "gpt-6.1-sol" } } },
  };

  it("applies engines, features, MCP servers and bots in order with placeholders resolved", async () => {
    const h = harness();
    const applied = await applyEnterpriseSetup(setup, h.deps);
    expect(h.calls).toEqual(["instances", "features", "mcp", "bot:b1"]);
    expect(applied).toEqual({ instances: ["sol"], mcpServers: ["studio"], features: ["managedCodex"], bots: ["b1"] });
    const node = nodeShimPath(h.dataDir);
    expect(h.seen.mcp).toEqual({ studio: { command: node, args: [`${h.dataDir}/workspaces/b1/tools/studio-mcp.mjs`], env: {}, enabled: true } });
    expect(h.seen.b1).toEqual({ cwd: `${h.dataDir}/workspaces/b1`, modelSelection: { instanceId: "sol", model: "gpt-6.1-sol" } });
    if (process.platform !== "win32") expect(existsSync(node)).toBe(true);
    expect(existsSync(join(h.dataDir, "workspaces", "b1"))).toBe(true);
    // Idempotent: a resumed run applies the same document with the same result.
    expect(await applyEnterpriseSetup(setup, h.deps)).toEqual(applied);
  });

  it("validates everything before writing anything", async () => {
    const h = harness();
    await expect(applyEnterpriseSetup({ ...setup, bots: { missing: {} } }, h.deps)).rejects.toMatchObject({ status: 409 });
    await expect(applyEnterpriseSetup({ ...setup, version: 2 }, h.deps)).rejects.toThrow(/invalid/);
    await expect(applyEnterpriseSetup({ ...setup, extra: 1 }, h.deps)).rejects.toThrow(/invalid/);
    await expect(applyEnterpriseSetup({ ...setup, bots: { b1: { cwd: "/x", token: "t" } } }, h.deps)).rejects.toThrow(/invalid/);
    await expect(applyEnterpriseSetup(setup, { ...h.deps, parseMcpServer: () => ({ ok: false as const, error: "bad command" }) })).rejects.toThrow(/studio.*bad command/);
    expect(h.calls).toEqual([]);
  });

  it("only writes the shim when the document asks for {{NODE}}", async () => {
    const h = harness();
    await applyEnterpriseSetup({ version: 1, features: { managedCodex: true } }, h.deps);
    expect(existsSync(nodeShimPath(h.dataDir))).toBe(false);
  });

  it("never creates a working folder outside the data folder", async () => {
    const h = harness();
    const outside = join(temp(), "elsewhere");
    await applyEnterpriseSetup({ version: 1, bots: { b1: { cwd: outside } } }, h.deps);
    expect(existsSync(outside)).toBe(false);
  });
});
