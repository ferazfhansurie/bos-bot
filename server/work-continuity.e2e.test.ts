// Thread-aware bots, end to end against the real harness server.
//
// A bot can open a real thread — on itself for separate work, or on a
// teammate as a handoff into a fresh thread — and the person sees each as
// a row under that bot. The claims pinned here need the whole harness: the
// per-bot slot limit deciding "runs now" against "waits in line", the chip
// and the opener record every client reads, and the same gates every peer
// path already has. Turns are held open by a gated fake CLI so the slot
// arithmetic is observable rather than raced.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";


const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const FAKE_ACP = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const TEST_CAPABILITY_KEY = "thread-aware-bots-fixture-capability";

let child: ChildProcess;
let home = "";
let gates = "";
let base = "";
let stderr = "";
const evidence: any[] = [];

const api = async (
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: response.status === 204 ? null : await response.json() };
};

/** Let one held turn finish. A gate written before the turn starts lets it
 * finish the moment it does. Depth-1 turns (no agents server, so no thread
 * id in their MCP config) share the "peer" gate. */
const release = (threadId: string) => writeFileSync(join(gates, `${threadId}.gate`), "finish");
const dumpOf = (threadId: string): { systemPrompt?: string; mcpConfig?: any } | undefined => {
  try {
    return JSON.parse(readFileSync(join(gates, `${threadId}.json`), "utf8"));
  } catch {
    return undefined;
  }
};
const promptsOf = (threadId: string): any[] => {
  try {
    return readFileSync(join(gates, `${threadId}.prompts.jsonl`), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  } catch {
    return [];
  }
};
/** The live per-turn token of a held turn — the only credential the
 * internal endpoints accept, and the one a real tool call would carry. */
const liveToken = async (threadId: string, previous?: Record<string, string>): Promise<Record<string, string>> => {
  let authorization = "";
  // A new prompt is recorded before its dump is rewritten. Reject the old
  // turn's token and retain the successful read instead of racing a second read.
  await expect.poll(() => {
    const token = dumpOf(threadId)?.mcpConfig?.mcpServers?.agents?.env?.OMB_COMMS_TOKEN;
    authorization = token ? `Bearer ${token}` : "";
    return Boolean(authorization && authorization !== previous?.authorization);
  }, { timeout: 15_000 }).toBe(true);
  return { authorization };
};
/** Hold a fresh turn open on a bot's own thread and hand back its live
 * token. A wake that lands on that thread cannot start while this turn
 * runs, so the token stays valid for as long as the test holds the gate —
 * the way a real tool call reads the ledger. */
const heldTurn = async (bot: { id: string; threadId: string }, text: string): Promise<Record<string, string>> => {
  // idle first: an earlier turn still finishing must find its gate
  await expect.poll(async () => Boolean((await botState(bot.id))?.busy), { timeout: 15_000 }).toBe(false);
  rmSync(join(gates, `${bot.threadId}.gate`), { force: true });
  rmSync(join(gates, `${bot.threadId}.json`), { force: true });
  const sent = await api("POST", `/api/bots/${bot.id}/messages`, { text, threadId: bot.threadId });
  expect(sent.status).toBe(202);
  expect(sent.body.queued).toBeUndefined();
  return liveToken(bot.threadId);
};
/** Exercise the actual provider-mounted proxy, not a test-minted capability. */
const proxyCall = async (threadId: string, name: string, args: Record<string, unknown>) => {
  await liveToken(threadId);
  const server = dumpOf(threadId)!.mcpConfig.mcpServers.agents;
  const proxy = spawn(server.command, server.args, { cwd: ROOT, env: { ...process.env, ...server.env }, stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: proxy.stdout });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<any>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Mounted proxy ${name} timed out`)), 15_000);
      lines.on("line", line => {
        try {
          const response = JSON.parse(line);
          if (response.error) { reject(new Error(JSON.stringify(response.error))); return; }
          if (response.id === 1) {
            proxy.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
            proxy.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }) + "\n");
          }
          if (response.id === 2) resolve(response.result);
        } catch { reject(new Error("Mounted proxy returned malformed JSON")); }
      });
      proxy.once("error", reject);
      proxy.once("exit", (code, signal) => reject(new Error(`Mounted proxy exited before replying: ${signal ?? code}`)));
      proxy.stdin.on("error", reject);
      proxy.stderr.resume();
      proxy.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "thread-fixture", version: "1" } } }) + "\n");
    });
  } finally {
    clearTimeout(timer);
    lines.close();
    proxy.stdin.destroy();
    await waitForExit(proxy, { signal: "SIGTERM" });
  }
};
const bots = async () => (await api("GET", "/api/bots?messages=0")).body.bots as any[];
const botState = async (botId: string) => (await bots()).find((bot) => bot.id === botId);
const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).body.messages as any[];
const handoffs = (): any[] => { try { return JSON.parse(readFileSync(join(home, ".openmausbot", "room-handoffs.json"), "utf8")); } catch { return []; } };
const coordinated = async (headers: Record<string, string>, botId: string, message: string, requestKey: string) => {
  const response = await api("POST", "/api/internal/coordinate-bots", { botIds: [botId], message, requestKey }, headers);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(response.body.accepted).toHaveLength(1);
  return handoffs().find(node => node.id === response.body.accepted[0].requestId);
};

const createBot = async (name: string, instanceId = "gated", model = "claude-sonnet-5") => {
  const created = (await api("POST", "/api/bots", {})).body.bot;
  const patched = await api("PATCH", `/api/bots/${created.id}`, { name, notifications: true, modelSelection: { instanceId, model } });
  expect(patched.status).toBe(200);
  return patched.body.bot;
};

const cleanup = async (botIds: string[]) => {
  for (const botId of botIds) {
    const b = await botState(botId);
    let planRows: any[] = [], aliases: any[] = [];
    try { planRows = JSON.parse(readFileSync(join(home, ".openmausbot", "work-plans.json"), "utf8")); } catch {}
    try { aliases = JSON.parse(readFileSync(join(home, ".openmausbot", "room-runtime-aliases.json"), "utf8")); } catch {}
    const ids = new Set([...(b?.tasks ?? []).map((t: any) => t.threadId), ...planRows.filter(p => p.botId === botId).map(p => p.threadId)]);
    const threads = [];
    for (const threadId of ids) {
      const runtime = aliases.find(r => r[1].botId === botId && r[1].threadId === threadId)?.[0] ?? threadId;
      const transcript = await api("GET", `/api/threads/${threadId}/messages?limit=100`);
      threads.push({ threadId, runtime, dispatchCount: promptsOf(runtime).length, prompts: promptsOf(runtime), transcript: transcript.body.messages ?? [] });
    }
    evidence.push({ name: b?.name, botId, threads, plan: planRows.filter(p => p.botId === botId) });
  }
  for (const botId of botIds) await api("POST", `/api/bots/${botId}/interrupt`, {}).catch(() => undefined);
  for (const botId of botIds) await api("DELETE", `/api/bots/${botId}`).catch(() => undefined);
};

async function startFixture() {
  const port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["--loader", join(home, "fixture-loader.mjs"), join(SERVER_DIR, "index.ts")], {
    cwd: ROOT,
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(port),
      OMB_WEBHOOK_PORT: String(port + 1),
      OMB_TEST_INTERNAL_CAPABILITY_KEY: TEST_CAPABILITY_KEY,
      OMB_ENTERPRISE_DIR: join(home, "fake-layer"), OMB_LICENSE_KEY: "fixture-key",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr!.on("data", (chunk) => (stderr += chunk));

  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}: ${stderr}`);
    try {
      if ((await fetch(`${base}/api/health`)).status === 200) break;
    } catch {
      // still starting
    }
    if (Date.now() >= deadline) throw new Error(`server never became healthy: ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

beforeAll(async () => {
  chmodSync(FAKE_CLAUDE, 0o755);
  chmodSync(FAKE_ACP, 0o755);
  home = mkdtempSync(join(tmpdir(), "omb-work-continuity-"));
  gates = join(home, "gates");
  const data = join(home, ".openmausbot");
  // Personal-edition enterprise.ts intentionally has no entitlements. A
  // fixture-only ESM loader substitutes its stand-in for spend-cap coverage.
  const enterpriseFake = join(home, "enterprise.ts");
  writeFileSync(enterpriseFake, readFileSync(join(SERVER_DIR, "enterprise.ts"), "utf8").replace('features: []', 'features: ["budgets"]').replace('return false }\nexport function describeEdition', 'return _feature === "budgets" }\nexport function describeEdition'));
  writeFileSync(join(home, "fixture-loader.mjs"), `export async function resolve(specifier, context, next) { if (specifier.endsWith("/enterprise.ts") && context.parentURL?.includes("${SERVER_DIR}/")) return next(${JSON.stringify(pathToFileURL(enterpriseFake).href)}, context); return next(specifier, context); }`);
  const layerDir = join(home, "fake-layer");
  mkdirSync(join(layerDir, "server"), { recursive: true });
  writeFileSync(join(layerDir, "server", "index.js"), 'export async function register() { return { customer: "Fixture Co", features: ["budgets", "billing"], expiresAt: "2099-01-01" }; }\n');
  mkdirSync(data, { recursive: true });
  mkdirSync(gates, { recursive: true });
  // Every turn holds until its gate exists, and dumps its argv/env/prompt
  // under its gate key — the only way a test can read a live comms token
  // or a bot's assembled system prompt. The key is a [[gate:NAME]] marker
  // in the first prompt line when the test put one there, else the agents
  // server's thread id (depth-0 turns only), else "peer". Depth-1 turns
  // carry no thread id anywhere in argv or env, so the marker is what lets
  // two of a peer's threads be held and released separately.
  const controlledFake = join(home, "controlled-claude.ts");
  writeFileSync(controlledFake, readFileSync(FAKE_CLAUDE, "utf8")
    .replace('import { spawnSync }', 'import { unlinkSync } from "node:fs";\nimport { spawnSync }')
    .replace('"./room-handoff-agent.ts"', JSON.stringify(pathToFileURL(join(SERVER_DIR, "testing", "room-handoff-agent.ts")).href))
    .replace('        clearInterval(poll);', '        clearInterval(poll); unlinkSync(finishGate);')
    .replaceAll('out({ type: "result", is_error: false, stop_reason: "end_turn",', 'out({ type: "result", is_error: existsSync((process.env.FAKE_CLAUDE_SLOW_FINISH_GATE ?? "") + ".fail"), stop_reason: "end_turn",')
    .replaceAll('    turnRunning = false;', '    if (existsSync((process.env.FAKE_CLAUDE_SLOW_FINISH_GATE ?? "") + ".duplicate")) out({ type: "result", is_error: false, stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } });\n    turnRunning = false;'));
  const gated = join(home, "gated-claude.mjs");
  writeFileSync(gated, [
    "#!/usr/bin/env node",
    'import { readFileSync } from "node:fs";',
    'import { join } from "node:path";',
    'import { PassThrough } from "node:stream";',
    'const at = process.argv.indexOf("--mcp-config");',
    "let thread = null;",
    "if (at >= 0) {",
    "  try {",
    '    const servers = JSON.parse(readFileSync(process.argv[at + 1], "utf8")).mcpServers ?? {};',
    "    for (const server of Object.values(servers)) thread ??= server?.env?.OMB_THREAD_ID ?? null;",
    "  } catch {}",
    "}",
    "const relay = new PassThrough();",
    "const real = process.stdin;",
    'Object.defineProperty(process, "stdin", { value: relay, configurable: true });',
    "let decided = false;",
    'let held = "";',
    'real.on("data", (chunk) => {',
    "  if (decided) { relay.write(chunk); return; }",
    "  held += chunk;",
    '  const nl = held.indexOf("\\n");',
    "  if (nl === -1) return;",
    "  const marker = /\\[\\[gate:([\\w-]+)\\]\\]/.exec(held.slice(0, nl));",
    '  const key = marker?.[1] ?? thread ?? "peer";',
    `  process.env.FAKE_CLAUDE_SLOW_FINISH_GATE = join(${JSON.stringify(gates)}, key + ".gate");`,
    `  process.env.FAKE_CLAUDE_DUMP = join(${JSON.stringify(gates)}, key + ".json");`,
    `  process.env.FAKE_CLAUDE_PROMPTS = join(${JSON.stringify(gates)}, key + ".prompts.jsonl");`,
    "  decided = true;",
    "  relay.write(held);",
    '  held = "";',
    "});",
    'real.on("end", () => relay.end());',
    'process.env.FAKE_CLAUDE_MODE = "slow";',
    `await import(${JSON.stringify(pathToFileURL(FAKE_CLAUDE).href)});`,
  ].join("\n"), { mode: 0o700 });
  const manual = join(home, "manual-claude.mjs");
  writeFileSync(manual, readFileSync(gated, "utf8").replace(pathToFileURL(FAKE_CLAUDE).href, pathToFileURL(controlledFake).href), { mode: 0o700 });
  writeFileSync(join(data, "config.json"), JSON.stringify({
    threads: { maxConcurrentPerBot: 2 },
    instances: {
      manual: { driver: "claudeAgent", displayName: "Manual fixture", config: { cli: manual } },
      gated: {
        driver: "claudeAgent",
        displayName: "Gated fixture",
        config: { cli: gated },
      },
      // stops mid-turn to ask the person a question no rule may answer —
      // the card that has to reach a human even from a peer-opened thread
      curious: {
        driver: "grokAgent",
        displayName: "Curious fixture",
        environment: { FAKE_ACP_MODE: "question" },
        config: { cli: FAKE_ACP, fullAuto: true },
      },
    },
  }));
  await startFixture();
}, 45_000);

afterAll(async () => {
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  writeFileSync(join(ROOT, "docs", "verification", "work-continuity-runtime-evidence.json"), JSON.stringify({ fixtureOnly: true, evidence }, null, 2));
  if (home) await removeTempDir(home);
});


const optIn = async (name: string, instanceId = "gated") => {
  const b = await createBot(name, instanceId);
  expect((await api("PATCH", `/api/bots/${b.id}`, { workContinuity: true })).status).toBe(200);
  return b;
};
const rosterCheck = async (headers: Record<string, string>) => {
  const state = await api("GET", "/api/internal/work-plan", undefined, headers);
  expect(state.status).toBe(200);
  return state.body.team.map((b: any) => ({ botId: b.botId, decision: b.hasOutstandingWork ? "already_working" : b.available ? "no_ready_work" : "unavailable", reason: "No independently authorized work for this fixture peer", stepIds: [] }));
};
const ownPlan = (b: any, teamCheck: any[], status = "ready") => ({ expectedRevision: 0, outcome: "Fixture authorized build", status: "active", teamCheck,
  steps: [{ id: "own", ownerBotId: b.id, action: "Finish isolated fixture own work", status, dependsOn: [], ...(status === "waiting" ? { reason: "Waiting for dependency" } : {}) }] });
const idle = async (b: any) => expect.poll(async () => Boolean((await botState(b.id))?.busy), { timeout: 15000 }).toBe(false);
const count = (b: any) => promptsOf(b.threadId).length;
const runtimeRow = (botId: string, threadId: string): any => { try { return JSON.parse(readFileSync(join(home, ".openmausbot", "work-runtime.json"), "utf8")).find((r: any) => r.botId === botId && r.threadId === threadId); } catch { return undefined; } };
const roomRuntime = async (botId: string, threadId: string) => {
  let runtime = "";
  await expect.poll(() => { try { runtime = JSON.parse(readFileSync(join(home, ".openmausbot", "room-runtime-aliases.json"), "utf8")).find((r: any) => r[1].botId === botId && r[1].threadId === threadId)?.[0]; return runtime; } catch { return ""; } }, { timeout: 15000 }).toBeTruthy();
  return runtime;
};

describe("work continuity real server", () => {
  it("ordinary bot stays one dispatch; opted-in missing plan has exactly one retry", async () => {
    const plain = await createBot("Plain");
    await heldTurn(plain, "Simple ordinary answer"); release(plain.threadId); await idle(plain);
    await new Promise(r => setTimeout(r, 300)); expect(count(plain)).toBe(1);
    const lead = await optIn("Missing");
    await heldTurn(lead, "Work without a disposition"); release(lead.threadId);
    await expect.poll(() => count(lead), { timeout: 15000 }).toBe(2); await idle(lead);
    expect((await messages(lead.threadId)).some(m => m.tool?.name.includes("disposition retry exhausted"))).toBe(true);
    await cleanup([plain.id, lead.id]);
  }, 45000);
  it("own ready work continues on the same direct thread and missing next disposition stays bounded", async () => {
    const lead = await optIn("Own"); const h = await heldTurn(lead, "Build this authorized fixture");
    const p = ownPlan(lead, await rosterCheck(h));
    expect((await api("POST", "/api/internal/work-plan", { plan: p }, h)).status).toBe(200);
    release(lead.threadId);
    await expect.poll(() => count(lead), { timeout: 15000 }).toBe(3); await idle(lead);
    expect(JSON.stringify(promptsOf(lead.threadId))).toContain("independently runnable");
    const ledger = JSON.parse(readFileSync(join(home, ".openmausbot", "work-plans.json"), "utf8"));
    expect(ledger.find((p: any) => p.botId === lead.id).attempts).toBe(1);
    expect((await botState(lead.id)).tasks).toHaveLength(1);
    await cleanup([lead.id]);
  }, 45000);
  it("all waiting and explicit no actionable work finish without extra dispatch", async () => {
    for (const noWork of [false, true]) {
      const lead = await optIn(noWork ? "Answer" : "Wait"); const h = await heldTurn(lead, "Fixture waiting or answer");
      const team = await rosterCheck(h);
      const result = await api("POST", "/api/internal/work-plan", noWork ? { no_actionable_work: true, reason: "Only a factual answer requested", team_check: team } : { plan: ownPlan(lead, team, "waiting") }, h);
      expect(result.status).toBe(200); release(lead.threadId); await idle(lead);
      await new Promise(r => setTimeout(r, 300)); expect(count(lead)).toBe(1); await cleanup([lead.id]);
    }
  }, 45000);

  it("continuing an edited human turn preserves the edited transcript branch", async () => {
    const lead = await optIn("Edited", "manual"); let h = await heldTurn(lead, "Original human request");
    expect((await api("POST", "/api/internal/work-plan", { plan: ownPlan(lead, await rosterCheck(h), "waiting") }, h)).status).toBe(200);
    release(lead.threadId); await idle(lead);
    const source = (await messages(lead.threadId)).find(m => m.role === "user");
    const edited = await api("POST", `/api/bots/${lead.id}/messages/${source.id}/edit`, { threadId: lead.threadId, text: "Edited human request" });
    expect(edited.status).toBe(202); await expect.poll(() => count(lead), { timeout: 15000 }).toBe(2); h = await liveToken(lead.threadId, h);
    const current = (await api("GET", "/api/internal/work-plan", undefined, h)).body.plan;
    expect((await api("POST", "/api/internal/work-plan", { plan: { ...ownPlan(lead, await rosterCheck(h)), expectedRevision: current.revision } }, h)).status).toBe(200);
    release(lead.threadId); await expect.poll(() => count(lead), { timeout: 15000 }).toBe(3); h = await liveToken(lead.threadId, h);
    expect((await messages(lead.threadId)).find(m => m.id === edited.body.message.id).text).toBe("Edited human request");
    const plan = (await api("GET", "/api/internal/work-plan", undefined, h)).body.plan;
    expect((await api("POST", "/api/internal/work-plan", { plan: { expectedRevision: plan.revision, outcome: plan.outcome, status: "completed", steps: plan.steps.map((step: any) => ({ ...step, status: "done", evidence: "Fixture own work checked" })), teamCheck: await rosterCheck(h) } }, h)).status).toBe(200);
    release(lead.threadId); await idle(lead); expect(count(lead)).toBe(3);
    expect((await messages(lead.threadId)).filter(m => m.role === "user").every(m => !m.text.includes("Continue your independently runnable"))).toBe(true);
    await cleanup([lead.id]);
  }, 45000);
  it("stop holds only its own chain: no self-restart, any new human message releases it, stop/pause keep it", async () => {
    const lead = await optIn("Stop"); let h = await heldTurn(lead, "Build authorized fixture");
    expect((await api("POST", "/api/internal/work-plan", { plan: ownPlan(lead, await rosterCheck(h)) }, h)).status).toBe(200);
    await api("POST", `/api/bots/${lead.id}/interrupt`, {}); await idle(lead);
    await new Promise(r => setTimeout(r, 300)); expect(count(lead)).toBe(1);
    h = await heldTurn(lead, "A different question");
    const read = await api("GET", "/api/internal/work-plan", undefined, h); expect(read.body.held).toBe(false);
    const update = { ...ownPlan(lead, await rosterCheck(h), "waiting"), expectedRevision: read.body.plan.revision };
    expect((await api("POST", "/api/internal/work-plan", { plan: update }, h)).status).toBe(200);
    release(lead.threadId); await idle(lead); expect(count(lead)).toBe(2);
    h = await heldTurn(lead, "stop"); expect((await api("GET", "/api/internal/work-plan", undefined, h)).body.held).toBe(true);
    release(lead.threadId); await idle(lead);
    h = await heldTurn(lead, "resume"); expect((await api("GET", "/api/internal/work-plan", undefined, h)).body.held).toBe(false);
    await cleanup([lead.id]);
  }, 45000);
  it("rejects caller scope fields, unknown owner and stale revision", async () => {
    const lead = await optIn("Scope"); const h = await heldTurn(lead, "Scope fixture"); const p = ownPlan(lead, await rosterCheck(h));
    expect((await api("POST", "/api/internal/work-plan", { plan: p, threadId: "elsewhere" }, h)).status).toBe(403);
    expect((await api("POST", "/api/internal/work-plan", { plan: p, chainId: "forged" }, h)).status).toBe(400);
    expect((await api("POST", "/api/internal/work-plan", { plan: { ...p, steps: [{ ...p.steps[0], ownerBotId: "unreachable" }] } }, h)).status).toBe(403);
    expect((await api("POST", "/api/internal/work-plan", { plan: p }, h)).status).toBe(200);
    expect((await api("POST", "/api/internal/work-plan", { plan: p }, h)).status).toBe(409);
    await cleanup([lead.id]);
  }, 45000);
  it("mounted native proxy exposes scoped read and accepts explicit no-work disposition", async () => {
    const lead = await optIn("Proxy"); const h = await heldTurn(lead, "Simple fixture answer");
    const read = await proxyCall(lead.threadId, "get_work_plan", {}); expect(JSON.stringify(read)).toContain("team");
    const result = await proxyCall(lead.threadId, "update_work_plan", { no_actionable_work: true, reason: "Only an answer requested", team_check: await rosterCheck(h) });
    expect(result.isError).not.toBe(true); release(lead.threadId); await idle(lead); expect(count(lead)).toBe(1); await cleanup([lead.id]);
  }, 45000);
  it("two own continuations are capped despite model updates and terminal replay is inert", async () => {
    const lead = await optIn("Capped", "manual"); let h = await heldTurn(lead, "Authorized three-phase fixture");
    writeFileSync(join(gates, lead.threadId + ".gate.duplicate"), "yes");
    for (let n = 0; n < 3; n++) {
      const prior = (await api("GET", "/api/internal/work-plan", undefined, h)).body.plan;
      const p = { ...ownPlan(lead, await rosterCheck(h)), expectedRevision: prior?.revision ?? 0 };
      expect((await api("POST", "/api/internal/work-plan", { plan: p }, h)).status).toBe(200);
      release(lead.threadId);
      if (n < 2) {
        await expect.poll(() => count(lead), { timeout: 15000 }).toBe(n + 2);
        h = await liveToken(lead.threadId);
      }
    }
    await idle(lead); await new Promise(r => setTimeout(r, 300)); expect(count(lead)).toBe(3);
    expect((await messages(lead.threadId)).some(m => m.tool?.name.includes("continuation limit"))).toBe(true);
    const records = JSON.parse(readFileSync(join(home, ".openmausbot", "work-plans.json"), "utf8"));
    expect(records.find((r: any) => r.botId === lead.id).attempts).toBe(2);
    await cleanup([lead.id]);
  }, 45000);
  it("helper assignment is accepted exactly once and own work continues while helper runs", async () => {
    const lead = await optIn("Parallel", "manual"); const worker = await createBot("Helper", "manual");
    const h = await heldTurn(lead, "Authorized own and helper fixture work"); const team = await rosterCheck(h);
    const p = ownPlan(lead, team);
    p.steps.push({ id: "helper", ownerBotId: worker.id, action: "Independently verify the authorized fixture", status: "ready", dependsOn: [] });
    p.teamCheck = p.teamCheck.map((c: any) => c.botId === worker.id ? { ...c, decision: "assign", stepIds: ["helper"] } : c);
    const saved = await api("POST", "/api/internal/work-plan", { plan: p }, h); expect(saved.status).toBe(200);
    const assignment = saved.body.assignments[0];
    await coordinated(h, worker.id, assignment.message, assignment.requestKey);
    await coordinated(h, worker.id, assignment.message, assignment.requestKey);
    expect(handoffs().filter(n => n.key === assignment.requestKey + ":" + worker.id)).toHaveLength(1);
    release(lead.threadId);
    await expect.poll(() => count(lead), { timeout: 15000 }).toBe(2);
    await expect.poll(() => handoffs().some(n => n.botId === worker.id && n.status === "running"), { timeout: 15000 }).toBe(true);
    const held = await liveToken(lead.threadId);
    const read = await api("GET", "/api/internal/work-plan", undefined, held);
    expect(read.body.plan.steps.find((s: any) => s.id === "helper").status).toBe("waiting");
    expect(read.body.team.find((c: any) => c.botId === worker.id).hasOutstandingWork).toBe(true);
    const plan = read.body.plan;
    const changed = await api("POST", "/api/internal/work-plan", { plan: { expectedRevision: plan.revision, outcome: plan.outcome, status: "active", steps: plan.steps.map((step: any) => step.id === "helper" ? { ...step, ownerBotId: lead.id, status: "ready" } : step), teamCheck: await rosterCheck(held) } }, held);
    expect(changed.status).toBe(409);
    expect(changed.body.error).toContain("remains owned");
    await cleanup([lead.id, worker.id]);
  }, 45000);

  it("helper result resumes parent exactly once and wins over a competing own continuation", async () => {
    const lead = await optIn("WakeRace", "manual"); const worker = await createBot("WakeWorker", "manual");
    const h = await heldTurn(lead, "Authorized parent wake fixture"); const p = ownPlan(lead, await rosterCheck(h));
    p.steps.push({ id: "helper", ownerBotId: worker.id, action: "Check independent fixture work", status: "ready", dependsOn: [] });
    p.teamCheck = p.teamCheck.map((c: any) => c.botId === worker.id ? { ...c, decision: "assign", stepIds: ["helper"] } : c);
    const saved = await api("POST", "/api/internal/work-plan", { plan: p }, h);
    const a = saved.body.assignments[0]; const node = await coordinated(h, worker.id, a.message, a.requestKey);
    release(lead.threadId); await expect.poll(() => count(lead), { timeout: 15000 }).toBe(2);
    await expect.poll(() => promptsOf(node.threadId).length, { timeout: 15000 }).toBe(1);
    const own = await liveToken(lead.threadId); const current = (await api("GET", "/api/internal/work-plan", undefined, own)).body.plan;
    expect((await api("POST", "/api/internal/work-plan", { plan: { expectedRevision: current.revision, outcome: current.outcome, status: "active", steps: current.steps, teamCheck: await rosterCheck(own) } }, own)).status).toBe(200);
    writeFileSync(join(gates, node.threadId + ".gate.duplicate"), "yes"); release(node.threadId);
    await expect.poll(() => handoffs().find(n => n.id === node.id)?.status, { timeout: 15000 }).toBe("completed");
    await expect.poll(() => handoffs().some(n => n.botId === lead.id && n.status === "resume"), { timeout: 15000 }).toBe(true);
    expect(count(lead)).toBe(2); release(lead.threadId);
    await expect.poll(() => count(lead), { timeout: 15000 }).toBe(3);
    const resumed = await liveToken(lead.threadId); const plan = (await api("GET", "/api/internal/work-plan", undefined, resumed)).body.plan;
    expect((await api("POST", "/api/internal/work-plan", { plan: { expectedRevision: plan.revision, outcome: plan.outcome, status: "completed", steps: plan.steps.map((step: any) => ({ ...step, status: "done", evidence: "Fixture lead inspected recipient transcript and performed own verification" })), teamCheck: await rosterCheck(resumed) } }, resumed)).status).toBe(200);
    release(lead.threadId); await idle(lead); await new Promise(r => setTimeout(r, 300)); expect(count(lead)).toBe(3);
    expect(handoffs().filter(n => n.botId === lead.id && !n.parentId).map(n => n.executions)).toEqual([2]);
    await cleanup([lead.id, worker.id]);
  }, 45000);

  it("pause holds later helper results without reassigning or reviving the lead", async () => {
    const lead = await optIn("PausedParent", "manual"); const worker = await createBot("PauseWorker", "manual");
    const h = await heldTurn(lead, "Authorized helper fixture before pause"); const p = ownPlan(lead, await rosterCheck(h), "waiting");
    p.steps.push({ id: "helper", ownerBotId: worker.id, action: "Verify independently owned work", status: "ready", dependsOn: [] });
    p.teamCheck = p.teamCheck.map((c: any) => c.botId === worker.id ? { ...c, decision: "assign", stepIds: ["helper"] } : c);
    const saved = await api("POST", "/api/internal/work-plan", { plan: p }, h); const a = saved.body.assignments[0];
    const node = await coordinated(h, worker.id, a.message, a.requestKey);
    const current = (await api("GET", "/api/internal/work-plan", undefined, h)).body.plan;
    expect((await api("POST", "/api/internal/work-plan", { plan: { expectedRevision: current.revision, outcome: current.outcome, status: "paused", reason: "Human paused the parent work", steps: current.steps, teamCheck: await rosterCheck(h) } }, h)).status).toBe(200);
    release(lead.threadId);
    await expect.poll(() => promptsOf(node.threadId).length, { timeout: 15000 }).toBe(1); release(node.threadId);
    await expect.poll(() => handoffs().find(n => n.id === node.id)?.status, { timeout: 15000 }).toBe("completed");
    // The parent precedes its child in the scheduler: one tick reports the
    // child, then the next makes the parent resumable. Wait for that durable
    // state rather than assuming both 250ms ticks fit inside a 350ms sleep.
    await expect.poll(() => handoffs().some(n => n.botId === lead.id && n.status === "resume"), { timeout: 15000 }).toBe(true);
    expect(handoffs().find(n => n.id === node.id)?.reported).toBe(true);
    await new Promise(r => setTimeout(r, 350)); expect(count(lead)).toBe(1);
    expect(handoffs().some(n => n.botId === lead.id && n.status === "resume")).toBe(true);
    const ledger = JSON.parse(readFileSync(join(home, ".openmausbot", "work-plans.json"), "utf8"));
    expect(ledger.find((r: any) => r.botId === lead.id).plan.steps.find((step: any) => step.id === "helper").status).toBe("waiting");
    await cleanup([lead.id, worker.id]);
  }, 45000);
  it.each(["running", "paused", "stopped"])("coordinated room results respect %s state while a sibling direct thread remains running", async (state) => {
    const lead = state === "paused" ? await optIn("ConcurrentParent", "manual") : await createBot("ConcurrentParent", "manual");
    const worker = await createBot("ConcurrentHelper", "manual");
    const direct = await heldTurn(lead, "Private parent work stays running");
    if (state === "paused") expect((await api("POST", "/api/internal/work-plan", { no_actionable_work: true, reason: "Private fixture only needs one answer", team_check: await rosterCheck(direct) }, direct)).status).toBe(200);
    const room = (await api("POST", "/api/groups", { name: "Concurrent results", memberIds: [lead.id, worker.id], setup: { bulletin: "", defaultResponder: { kind: "mentions" } } })).body.group;
    try {
      await api("POST", `/api/groups/${room.id}/messages`, { text: "@ConcurrentParent begin delegated review" });
      let runtime = "";
      await expect.poll(() => {
        try { runtime = JSON.parse(readFileSync(join(home, ".openmausbot", "room-runtime-aliases.json"), "utf8")).find((r: any) => r[1].botId === lead.id && r[1].threadId === room.threadId)?.[0]; return runtime; } catch { return ""; }
      }, { timeout: 15000 }).toBeTruthy();
      const h = await liveToken(runtime);
      const node = await coordinated(h, worker.id, "Check isolated room evidence", "concurrent-room-result");
      if (state === "paused") {
        const plan = { ...ownPlan(lead, await rosterCheck(h), "waiting"), status: "paused", reason: "Human paused room parent" };
        expect((await api("POST", "/api/internal/work-plan", { plan }, h)).status).toBe(200);
      }
      release(runtime);
      let workerRuntime = "";
      await expect.poll(() => {
        try { workerRuntime = JSON.parse(readFileSync(join(home, ".openmausbot", "room-runtime-aliases.json"), "utf8")).find((r: any) => r[1].botId === worker.id && r[1].threadId === room.threadId)?.[0]; return workerRuntime; } catch { return ""; }
      }, { timeout: 15000 }).toBeTruthy();
      await liveToken(workerRuntime);
      if (state === "stopped") expect((await api("POST", `/api/groups/${room.id}/interrupt`, { botId: lead.id })).status).toBe(200);
      release(workerRuntime);
      if (state === "running") await expect.poll(() => promptsOf(runtime).length, { timeout: 15000 }).toBe(2);
      else {
        await expect.poll(() => handoffs().find(n => n.id === node.parentId)?.status, { timeout: 15000 }).toBe(state === "paused" ? "resume" : "cancelled");
        await new Promise(resolve => setTimeout(resolve, 350));
        expect(promptsOf(runtime)).toHaveLength(1);
      }
      expect((await api("GET", "/api/internal/room-targets", undefined, direct)).status).toBe(200);
      expect(promptsOf(lead.threadId)).toHaveLength(1);
      expect((await botState(lead.id)).tasks.find((t: any) => t.threadId === lead.threadId).busy).toBe(true);
      if (state === "running") {
        release(runtime);
        await expect.poll(() => handoffs().find(n => n.id === node.parentId)?.status, { timeout: 15000 }).toBe("completed");
        expect(handoffs().find(n => n.id === node.parentId)?.executions).toBe(2);
        expect(promptsOf(runtime)).toHaveLength(2);
      }
      expect(promptsOf(workerRuntime)).toHaveLength(1);
      release(lead.threadId); await idle(lead);
    } finally { await api("DELETE", `/api/groups/${room.id}`); await cleanup([lead.id, worker.id]); }
  }, 45000);

  it("an earlier room Stop does not starve the owed helper result of a newer human request", async () => {
    const lead = await optIn("HeldRoomLead", "manual"); const worker = await createBot("HeldRoomHelper", "manual");
    const room = (await api("POST", "/api/groups", { name: "Held lead", memberIds: [lead.id, worker.id], setup: { bulletin: "", defaultResponder: { kind: "mentions" } } })).body.group;
    try {
      await api("POST", `/api/groups/${room.id}/messages`, { text: "@HeldRoomLead first request" });
      const runtime = await roomRuntime(lead.id, room.threadId); let h = await liveToken(runtime);
      expect((await api("POST", `/api/groups/${room.id}/interrupt`, { botId: lead.id })).status).toBe(200);
      await expect.poll(() => runtimeRow(lead.id, room.threadId)?.held, { timeout: 15000 }).toBe(true); await idle(lead);
      await api("POST", `/api/groups/${room.id}/messages`, { text: "@HeldRoomLead second request" });
      h = await liveToken(runtime, h);
      const node = await coordinated(h, worker.id, "Check isolated room evidence", "held-room-result");
      release(runtime);
      const workerRuntime = await roomRuntime(worker.id, room.threadId); await liveToken(workerRuntime); release(workerRuntime);
      await expect.poll(() => handoffs().find(n => n.id === node.id)?.status, { timeout: 15000 }).toBe("completed");
      await expect.poll(() => promptsOf(runtime).length, { timeout: 15000 }).toBe(3);
      h = await liveToken(runtime, h); expect((await api("GET", "/api/internal/work-plan", undefined, h)).body.held).toBe(false);
      release(runtime); await idle(lead);
    } finally { await api("DELETE", `/api/groups/${room.id}`); await cleanup([lead.id, worker.id]); }
  }, 45000);
  it("a teammate's addressed room mention releases the Stop hold and wakes the held bot", async () => {
    const lead = await optIn("MentionLead", "manual"); const worker = await createBot("MentionHelper", "manual");
    const room = (await api("POST", "/api/groups", { name: "Mention wake", memberIds: [lead.id, worker.id], setup: { bulletin: "", defaultResponder: { kind: "mentions" } } })).body.group;
    try {
      await api("POST", `/api/groups/${room.id}/messages`, { text: "@MentionLead @MentionHelper start the fixture\n@MentionLead sync when the helper is done" });
      const runtime = await roomRuntime(lead.id, room.threadId); await liveToken(runtime);
      const workerRuntime = await roomRuntime(worker.id, room.threadId); await liveToken(workerRuntime);
      expect((await api("POST", `/api/groups/${room.id}/interrupt`, { botId: lead.id })).status).toBe(200);
      await expect.poll(() => runtimeRow(lead.id, room.threadId)?.held, { timeout: 15000 }).toBe(true);
      await new Promise(r => setTimeout(r, 300)); expect(promptsOf(runtime)).toHaveLength(1); const before = promptsOf("peer").length;
      release(workerRuntime);
      // The mention is a depth-1 room turn (no agents server), so it is gated on "peer".
      await expect.poll(() => promptsOf("peer").length, { timeout: 15000 }).toBe(before + 1);
      await expect.poll(() => runtimeRow(lead.id, room.threadId)?.held, { timeout: 15000 }).toBe(false);
      // The echoing fixture replies keep mentioning each other; stop the room to end the chain.
      release("peer"); expect((await api("POST", `/api/groups/${room.id}/interrupt`, {})).status).toBe(200);
      await idle(lead); await idle(worker); expect(promptsOf(runtime)).toHaveLength(1);
    } finally { await api("DELETE", `/api/groups/${room.id}`); await cleanup([lead.id, worker.id]); }
  }, 45000);

  it("same-thread room continuation keeps canonical scoped plan and does not open another room", async () => {
    const lead = await optIn("RoomLead");
    const created = await api("POST", "/api/groups", { name: "Continuity room", memberIds: [lead.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: lead.id } } });
    expect(created.status).toBe(201); const room = created.body.group;
    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "Authorized room fixture", threadId: room.threadId })).status).toBe(202);
    let runtime = "";
    await expect.poll(() => {
      try { runtime = JSON.parse(readFileSync(join(home, ".openmausbot", "room-runtime-aliases.json"), "utf8")).find((r: any) => r[1].botId === lead.id)[0]; return runtime; } catch { return ""; }
    }, { timeout: 15000 }).toBeTruthy();
    const h = await liveToken(runtime);
    expect((await api("POST", "/api/internal/work-plan", { plan: ownPlan(lead, await rosterCheck(h)) }, h)).status).toBe(200);
    release(runtime);
    await expect.poll(() => promptsOf(runtime).length, { timeout: 15000 }).toBe(3); await idle(lead);
    const records = JSON.parse(readFileSync(join(home, ".openmausbot", "work-plans.json"), "utf8"));
    expect(records.find((r: any) => r.botId === lead.id).threadId).toBe(room.threadId);
    await api("DELETE", `/api/groups/${room.id}`); await cleanup([lead.id]);
  }, 45000);

  it("human-reserved work and a paused plan stay idle", async () => {
    for (const paused of [false, true]) {
      const lead = await optIn(paused ? "Pause" : "HumanGate"); const h = await heldTurn(lead, "Human fixture gate");
      const p = ownPlan(lead, await rosterCheck(h), "waiting");
      p.steps.push({ id: "human", ownerBotId: "human", action: "Human verifies fixture result", status: "ready", dependsOn: [] });
      const plan = { ...p, ...(paused ? { status: "paused", reason: "Human asked to pause" } : {}) };
      expect((await api("POST", "/api/internal/work-plan", { plan }, h)).status).toBe(200);
      release(lead.threadId); await idle(lead); await new Promise(r => setTimeout(r, 200)); expect(count(lead)).toBe(1);
      if (paused) {
        const state = JSON.parse(readFileSync(join(home, ".openmausbot", "work-runtime.json"), "utf8"));
        expect(state.find((r: any) => r.botId === lead.id).held).toBe(true);
      }
      await cleanup([lead.id]);
    }
  }, 45000);
  it("provider failure and revoked opt-in stop continuation; active permission changes are refused", async () => {
    for (const change of ["failure", "opt-out", "permissions"]) {
      const lead = await optIn("Refused" + change, "manual");
      if (change === "permissions") expect((await api("PATCH", `/api/bots/${lead.id}`, { approvalMode: "auto" })).status).toBe(200);
      const h = await heldTurn(lead, "Authorized ready fixture");
      expect((await api("POST", "/api/internal/work-plan", { plan: ownPlan(lead, await rosterCheck(h)) }, h)).status).toBe(200);
      if (change === "failure") writeFileSync(join(gates, lead.threadId + ".gate.fail"), "yes");
      else if (change === "opt-out") expect((await api("PATCH", `/api/bots/${lead.id}`, { workContinuity: false })).status).toBe(200);
      else {
        const changed = await api("PATCH", `/api/bots/${lead.id}`, { approvalMode: "ask" });
        expect(changed.status, JSON.stringify(changed.body)).toBe(409);
        expect((await botState(lead.id)).approvalMode).toBe("auto");
        await api("POST", `/api/bots/${lead.id}/interrupt`, {});
      }
      release(lead.threadId);
      try { await idle(lead); } catch (e) { throw new Error(JSON.stringify({ change, bot: await botState(lead.id), dispatches: count(lead), stderr }), { cause: e }); }
      await new Promise(r => setTimeout(r, 200)); expect(count(lead)).toBe(1);
      await cleanup([lead.id]);
    }
  }, 45000);
  it("newer human steering wins over ready old work", async () => {
    const lead = await optIn("Steering", "manual"); const h = await heldTurn(lead, "Build the old authorized work");
    expect((await api("POST", "/api/internal/work-plan", { plan: ownPlan(lead, await rosterCheck(h)) }, h)).status).toBe(200);
    expect((await api("POST", `/api/bots/${lead.id}/messages`, { text: "Answer this newer question", threadId: lead.threadId })).status).toBe(202);
    release(lead.threadId);
    await new Promise(r => setTimeout(r, 500));
    expect(JSON.stringify(promptsOf(lead.threadId))).not.toContain("Continue your independently runnable");
    await cleanup([lead.id]);
  }, 45000);
  it("plan read cannot cross threads and each new thread gets its own bounded preflight", async () => {
    const lead = await optIn("Separated", "manual"); const h = await heldTurn(lead, "Thread one fixture");
    expect((await api("POST", "/api/internal/work-plan", { plan: ownPlan(lead, await rosterCheck(h), "waiting") }, h)).status).toBe(200);
    expect((await api("GET", `/api/internal/work-plan?threadId=${lead.threadId}`, undefined, h)).status).toBe(400);
    release(lead.threadId); await idle(lead);
    const newTask = await api("POST", `/api/bots/${lead.id}/tasks`, { title: "Other fixture" }); expect(newTask.status).toBe(201);
    const threadId = newTask.body.task.threadId;
    expect((await api("POST", `/api/bots/${lead.id}/messages`, { text: "Other thread work", threadId })).status).toBe(202);
    const second = await liveToken(threadId);
    expect((await api("GET", "/api/internal/work-plan", undefined, second)).body.plan).toBeNull();
    await cleanup([lead.id]);
  }, 45000);

  it("pending peer approval sends nothing and denial leaves helper unassigned", async () => {
    const lead = await optIn("Approval", "manual"); const worker = await createBot("ApprovalWorker", "manual");
    expect((await api("PATCH", `/api/bots/${lead.id}`, { approvePeerComms: true })).status).toBe(200);
    const h = await heldTurn(lead, "Authorized helper requiring approval"); const p = ownPlan(lead, await rosterCheck(h));
    p.steps.push({ id: "approved-helper", ownerBotId: worker.id, action: "Verify only after human approves", status: "ready", dependsOn: [] });
    p.teamCheck = p.teamCheck.map((c: any) => c.botId === worker.id ? { ...c, decision: "assign", stepIds: ["approved-helper"] } : c);
    const saved = await api("POST", "/api/internal/work-plan", { plan: p }, h); const a = saved.body.assignments[0];
    const pending = api("POST", "/api/internal/coordinate-bots", { botIds: [worker.id], message: a.message, requestKey: a.requestKey }, h);
    await expect.poll(async () => (await messages(lead.threadId)).some(m => m.card?.tool === "delegate_bot"), { timeout: 15000 }).toBe(true);
    expect(handoffs().some(n => n.key === a.requestKey + ":" + worker.id)).toBe(false);
    const card = (await messages(lead.threadId)).find(m => m.card?.tool === "delegate_bot");
    expect((await api("POST", `/api/bots/${lead.id}/respond`, { threadId: lead.threadId, requestId: card.card.requestId, behavior: "deny" })).status).toBe(200);
    expect((await pending).status).toBe(403);
    expect(handoffs().some(n => n.key === a.requestKey + ":" + worker.id)).toBe(false);
    await cleanup([lead.id, worker.id]);
  }, 45000);
  it("workspace spend cap stops ready own continuation visibly", async () => {
    expect((await api("PUT", "/api/config", { budgets: { monthlyUsd: 1000 } })).status).toBe(200);
    const used = (await api("GET", "/api/usage")).body.budget.spentUsd;
    expect((await api("PUT", "/api/config", { budgets: { monthlyUsd: used + 0.005 } })).status).toBe(200);
    const lead = await optIn("Spend", "manual"); const h = await heldTurn(lead, "Ready work with spend gate");
    expect((await api("POST", "/api/internal/work-plan", { plan: ownPlan(lead, await rosterCheck(h)) }, h)).status).toBe(200);
    release(lead.threadId); await idle(lead); await new Promise(r => setTimeout(r, 300)); expect(count(lead)).toBe(1);
    expect((await messages(lead.threadId)).some(m => m.tool?.name.includes("monthly spend limit"))).toBe(true);
    expect((await api("PUT", "/api/config", { budgets: { monthlyUsd: 0 } })).status).toBe(200);
    await cleanup([lead.id]);
  }, 45000);
  it("native work_continuity proposal preserves boolean through reviewed profile persistence", async () => {
    const lead = await createBot("Proposal"); await heldTurn(lead, "Please enable work continuity");
    const result = await proxyCall(lead.threadId, "propose_profile", { work_continuity: true, reason: "Human requested the runtime behavior" });
    expect(result.isError).not.toBe(true);
    const card = (await messages(lead.threadId)).find(m => m.card?.profileRequest);
    expect(card.card.profileRequest.changes.workContinuity).toBe(true);
    expect((await api("POST", `/api/bots/${lead.id}/respond`, { threadId: lead.threadId, requestId: card.card.requestId, behavior: "allow" })).status).toBe(200);
    expect((await botState(lead.id)).workContinuity).toBe(true);
    expect(JSON.parse(readFileSync(join(home, ".openmausbot", "bots.json"), "utf8")).find((b: any) => b.id === lead.id).workContinuity).toBe(true);
    await cleanup([lead.id]);
  }, 45000);

  it("pending human profile approval stops own continuation", async () => {
    const lead = await optIn("HumanApproval", "manual"); const h = await heldTurn(lead, "Own fixture needing human approval");
    expect((await api("POST", "/api/internal/work-plan", { plan: ownPlan(lead, await rosterCheck(h)) }, h)).status).toBe(200);
    expect((await proxyCall(lead.threadId, "propose_profile", { title: "Review fixture", reason: "Human requested this change" })).isError).not.toBe(true);
    release(lead.threadId); await new Promise(r => setTimeout(r, 300)); expect(count(lead)).toBe(1);
    expect((await messages(lead.threadId)).some(m => m.card?.profileRequest && !m.card.answered)).toBe(true);
    await cleanup([lead.id]);
  }, 45000);
  it("server restart never replays ready plan or terminal continuation", async () => {
    const lead = await optIn("Restart", "manual"); const h = await heldTurn(lead, "Ready fixture before restart");
    expect((await api("POST", "/api/internal/work-plan", { plan: ownPlan(lead, await rosterCheck(h)) }, h)).status).toBe(200);
    await waitForExit(child, { signal: "SIGTERM" }); await startFixture();
    await new Promise(r => setTimeout(r, 400)); expect(count(lead)).toBe(1);
    expect((await botState(lead.id)).workContinuity).toBe(true);
    expect((await botState(lead.id)).busy).toBe(false);
    const records = JSON.parse(readFileSync(join(home, ".openmausbot", "work-plans.json"), "utf8"));
    expect(records.find((r: any) => r.botId === lead.id).attempts).toBe(0);
    await cleanup([lead.id]);
  }, 45000);

});
