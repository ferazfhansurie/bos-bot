import { generateKeyPairSync } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { verificationServerEnvironment } from "../scripts/control-omb.ts";
import { freePortBlock } from "./testing/ports.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

it("real HTTP never treats pending owner.json as readiness and rechecks status/prepare after retry and revocation", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const port = await freePortBlock([0, 1]);
  const data = mkdtempSync(join(tmpdir(), "remote-full-readiness-")); const base = `http://127.0.0.1:${port}`;
  let child: ChildProcess | undefined; let output = "";
  const evidence: unknown[] = [];
  const modeFile = join(data, "authority-mode.json");
  const mode = (value: string) => writeFileSync(modeFile, JSON.stringify(value));
  const call = async (path: string, method = "GET", body?: unknown, token?: string) => {
    const response = await fetch(base + path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json() as any;
    if (path.includes("remote-full")) evidence.push({ path, status: response.status, result });
    return { response, result };
  };
  try {
    mkdirSync(join(data, "tmp"));
    writeFileSync(join(data, "config.json"), JSON.stringify({ instances: { claude: { driver: "claudeAgent", config: { cli: join(root, "server/testing/fake-claude-cli.ts") } } } }));
    mode("pending");
    // Test-process bootstrap only. No product endpoint/config accepts a mock
    // authority. All CP traffic stays inside this owned process, offline.
    const bootstrap = join(data, "fixture.mjs");
    writeFileSync(bootstrap, `import { readFileSync } from 'node:fs';
      globalThis.fetch = async (url, init) => {
        if (!String(url).startsWith('https://authority.fixture.invalid/v1/remote-full/')) throw new Error('fixture network denied');
        const mode = JSON.parse(readFileSync(${JSON.stringify(modeFile)}, 'utf8'));
        if (mode === 'offline') throw new Error('synthetic unavailable');
        if (mode === 'revoked') return Response.json({error:'unauthorized'},{status:401});
        const body = JSON.parse(init.body);
        if (String(url).endsWith('/status')) return Response.json({enrolled: mode === 'verified' || mode === 'stale', probe: mode === 'stale' ? {...body.probe, nonce:'stale'} : body.probe});
        if (String(url).endsWith('/prepare') && mode === 'verified') return Response.json({prepared:true,state:'verified'});
        return Response.json({error:'owner_enrollment_required'},{status:403});
      };
      await import(${JSON.stringify(pathToFileURL(join(root, "server/index.ts")).href)});`);
    child = spawn(process.execPath, ["--experimental-strip-types", bootstrap], { cwd: root, env: { ...verificationServerEnvironment({}, data, port), BOS_CONTROL_PLANE_URL: "https://authority.fixture.invalid" }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout?.on("data", b => { output += b; }); child.stderr?.on("data", b => { output += b; });
    let ready = false;
    for (let i = 0; i < 150; i++) {
      if (child.exitCode !== null) throw new Error(`fixture exited: ${output.slice(-1500)}`);
      try { if ((await fetch(base + "/api/bots")).ok) { ready = true; break; } } catch {}
      await new Promise(r => setTimeout(r, 100));
    }
    expect(ready).toBe(true);
    const bot = (await call("/api/bots", "POST", { name: "Readiness fixture" })).result.bot;
    const pairing = (await call("/api/auth/pairing", "POST", { scopes: ["client"] })).result;
    const token = (await call("/api/auth/pair", "POST", { code: pairing.code, label: "readiness fixture" })).result.token;
    expect(typeof token).toBe("string");
    const environmentId = readFileSync(join(data, "environment-id"), "utf8").trim();
    const ownerPath = join(data, ".remote-full", "owner.json"); mkdirSync(join(data, ".remote-full"));
    const owner = { environmentId, installationId: "c67e2828-a514-4a46-9db9-07c28bce104a", audience: "https://fixture.invalid",
      privateKey: generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }), credential: `omb_install_${"a".repeat(22)}.${"b".repeat(43)}` };
    const bytes = JSON.stringify(owner); writeFileSync(ownerPath, bytes);
    const targets = [{ botId: bot.id, threadId: bot.threadId, updateBotDefault: true }];
    for (const failure of ["pending", "rejected", "lost-reply", "offline", "revoked", "stale"]) {
      mode(failure);
      const s = await call("/api/remote-full/status", "GET", undefined, token);
      expect(s.response.headers.get("cache-control")).toBe("no-store");
      expect(s.result.enrolled).toBe(false); expect(s.result.state).not.toBe("verified");
      expect(JSON.stringify(s.result)).not.toContain(owner.credential);
      expect((await call("/api/remote-full/prepare", "POST", targets, token)).response.status).toBe(403);
    }
    mode("verified"); // Exact credential retry, or fresh proof of a committed lost response.
    expect((await call("/api/remote-full/status", "GET", undefined, token)).result).toMatchObject({ enrolled: true, state: "verified" });
    expect((await call("/api/remote-full/prepare", "POST", targets, token)).response.status).toBe(200);
    mode("revoked");
    expect((await call("/api/remote-full/status", "GET", undefined, token)).result.enrolled).toBe(false);
    expect((await call("/api/remote-full/prepare", "POST", targets, token)).response.status).toBe(403);
    expect(readFileSync(ownerPath, "utf8")).toBe(bytes);
    expect((await call("/api/remote-full/status")).response.status).toBe(403);
    expect((await call(`/api/bots/${bot.id}`, "PATCH", { approvalMode: "full" })).response.status).toBe(403);
    expect((await call("/api/bots")).result.bots.find((b: any) => b.id === bot.id).approvalMode ?? "ask").toBe("ask");
  } finally {
    if (child && child.exitCode === null) { child.kill("SIGTERM"); await waitForExit(child); }
    const receipt = join(tmpdir(), `remote-full-readiness-${process.pid}.json`);
    writeFileSync(receipt, JSON.stringify(evidence, null, 2)); console.log(`readiness fixture receipt: ${receipt}`);
    await removeTempDir(data);
  }
}, 60000);
