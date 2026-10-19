// Enterprise first-launch provisioning, end to end and offline: a real source
// workspace (bot + conversation + tool file) is archived with
// createWorkspaceBackup, a tiny loopback HTTP server plays the hosted client
// endpoints, and the desktop flow (electron/enterprise-provision.mjs) runs
// against a second, fresh fixture server — restarting it exactly as the app
// does. Every directory is a disposable temp folder.
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

import { provisioningDue, runEnterpriseProvisioning } from "../electron/enterprise-provision.mjs";
import { runControlOmb } from "../scripts/control-omb.ts";
import { launchBackupFixture, restartFixture } from "../scripts/verify-workspace-backup.ts";
import { waitForExit } from "./testing/cleanup.ts";
import { createWorkspaceBackup } from "./workspace-backup.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const PASSWORD = "enterprise-fixture-password";
const TOKEN = "fixture-provision-token";

it.skipIf(process.platform === "win32")("provisions a fresh desktop workspace from a client archive and setup document", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "omb-enterprise-e2e-"));
  const source = await launchBackupFixture();
  let destination: Awaited<ReturnType<typeof launchBackupFixture>> | undefined;
  let destinationChild: ChildProcess | undefined;
  let endpoints: Server | undefined;
  try {
    // ── source workspace: one bot, one real conversation, one MCP tool file
    const control = (fixture: typeof source, ...args: string[]) => runControlOmb([...args, "--url", fixture.info.url]);
    const { bot } = await control(source, "new-bot", "--name", "Ops") as { bot: { id: string } };
    await control(source, "send", "--bot", bot.id, "--text", "Remember the acme launch plan.");
    expect((await control(source, "wait", "--bot", bot.id, "--timeout", "30") as { status: string }).status).toBe("settled");
    const tools = join(source.info.dataDir, "workspaces", bot.id, "tools");
    mkdirSync(tools, { recursive: true });
    copyFileSync(join(SERVER_DIR, "testing", "fake-mcp-server.ts"), join(tools, "studio-mcp.ts"));
    // The MCP server the setup names is plain JS, as a client's would be.
    writeFileSync(join(tools, "studio-mcp.mjs"), readFileSync(join(tools, "studio-mcp.ts"), "utf8").replace(" as { id?: number; method?: string }", ""));
    writeFileSync(join(source.info.dataDir, "workspaces", bot.id, "MEMORY.md"), "ENTERPRISE_MEMORY_MARKER\n");
    const original = (await (await fetch(`${source.info.url}/api/bots?messages=200`)).json() as { bots: Array<{ id: string; threadId: string; messages: Array<{ role: string; text?: string }> }> })
      .bots.find((candidate) => candidate.id === bot.id)!;
    expect(original.messages.some((message) => message.role === "user")).toBe(true);
    await waitForExit(source.child, { signal: "SIGTERM" });
    const backup = await createWorkspaceBackup(source.info.dataDir, { password: PASSWORD, appVersion: "fixture" });
    const archive = readFileSync(backup.path);

    // ── the hosted client endpoints
    const setup = {
      version: 1,
      features: { managedCodex: true },
      instances: { sol: { driver: "codex", displayName: "ChatGPT", config: { cli: join(SERVER_DIR, "testing", "fake-codex-app-server.ts") } } },
      mcpServers: { studio: { command: "{{NODE}}", args: [`{{DATA_DIR}}/workspaces/${bot.id}/tools/studio-mcp.mjs`], env: {}, enabled: true } },
      bots: { [bot.id]: { cwd: `{{DATA_DIR}}/workspaces/${bot.id}`, modelSelection: { instanceId: "sol", model: "gpt-6.1-sol" } } },
    };
    let burned = false;
    const hits: string[] = [];
    const doneBodies: unknown[] = [];
    endpoints = createServer((req, res) => {
      hits.push(`${req.method} ${req.url}`);
      if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(401).end(); return; }
      if (burned) { res.writeHead(410).end(); return; }
      if (req.url === "/v1/client/archive") {
        res.writeHead(200, { "content-type": "application/octet-stream", "content-length": archive.length, "x-bos-sha256": createHash("sha256").update(archive).digest("hex") });
        res.end(archive);
      } else if (req.url === "/v1/client/setup") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(setup));
      } else if (req.url === "/v1/client/done" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => { doneBodies.push(JSON.parse(body)); burned = true; res.writeHead(200).end("{}"); });
      } else res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => endpoints!.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(endpoints.address() as AddressInfo).port}/v1/client`;

    // ── the fresh desktop workspace and the flow the app runs
    destination = await launchBackupFixture();
    destinationChild = destination.child;
    const dataDir = destination.info.dataDir;
    const base = destination.info.url;
    const receipt = await runEnterpriseProvisioning({
      provision: { version: 1, slug: "acme", label: "sénira", url, token: TOKEN, password: PASSWORD },
      dataDir,
      tempRoot: join(scratch, "downloads"),
      appVersion: "fixture",
      localRequest: (route, init = {}) => fetch(`${base}${route}`, init as RequestInit),
      restartServer: async () => {
        destinationChild = await restartFixture({ ...destination!, child: destinationChild! });
      },
    });

    // receipt + token
    expect(receipt).toMatchObject({ slug: "acme", done: true, applied: { mcpServers: ["studio"], bots: [bot.id], features: ["managedCodex"], instances: ["sol"] } });
    const receiptText = readFileSync(join(dataDir, "enterprise-provision.json"), "utf8");
    for (const secret of [TOKEN, PASSWORD]) {
      expect(receiptText).not.toContain(secret);
      expect(JSON.stringify(doneBodies)).not.toContain(secret);
    }
    expect(existsSync(join(dataDir, "enterprise-provision-state.json"))).toBe(false);
    expect(hits.filter((hit) => !hit.startsWith("GET /v1/client/archive"))).toEqual(["GET /v1/client/setup", "POST /v1/client/done"]);
    expect((await fetch(`${url}/archive`, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(410);

    // bot, conversation, memory
    const after = (await (await fetch(`${base}/api/bots?messages=200`)).json() as { bots: Array<Record<string, any>> }).bots;
    const restored = after.find((candidate) => candidate.id === bot.id)!;
    expect(restored).toBeTruthy();
    expect(restored.threadId).toBe(original.threadId);
    expect(restored.messages.map((message: { text?: string }) => message.text)).toEqual(original.messages.map((message) => message.text));
    expect(restored.modelSelection).toMatchObject({ instanceId: "sol", model: "gpt-6.1-sol" });
    expect(restored.cwd).toBe(join(dataDir, "workspaces", bot.id));
    expect(readFileSync(join(dataDir, "workspaces", bot.id, "MEMORY.md"), "utf8")).toBe("ENTERPRISE_MEMORY_MARKER\n");

    // engine + feature + MCP server, and the MCP server actually starts via {{NODE}}
    const config = JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8"));
    expect(config.instances.sol).toMatchObject({ driver: "codex", displayName: "ChatGPT" });
    expect(config.instances.claude).toBeTruthy();
    expect(config.features.managedCodex).toBe(true);
    const shim = join(dataDir, "enterprise-runtime", "node");
    expect(statSync(shim).mode & 0o111).not.toBe(0);
    expect(config.mcpServers.studio).toMatchObject({ command: shim, args: [join(dataDir, "workspaces", bot.id, "tools", "studio-mcp.mjs")] });
    const probe = await (await fetch(`${base}/api/mcp/servers/studio/test`, { method: "POST" })).json() as { ok: boolean; tools?: Array<{ name: string }> };
    expect(probe).toMatchObject({ ok: true, tools: [{ name: "read_notes" }] });

    // The next launch has nothing left to do.
    expect(provisioningDue({ provision: { slug: "acme" } as never, dataDir })).toBe(false);
  } finally {
    endpoints?.close();
    if (destinationChild) await waitForExit(destinationChild, { signal: "SIGTERM" });
    await destination?.close();
    await source.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}, 180_000);
