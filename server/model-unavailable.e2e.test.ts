import { compatEnv } from "../electron/branding-env.cjs";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { freePortBlock } from "./testing/ports.ts";
import { waitForExit, removeTempDir } from "./testing/cleanup.ts";

// A Codex account that cannot use the bot's model (a free ChatGPT plan has no
// Sol) must never reach the person as a provider error: the real server
// switches to a model the account has and answers on it.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
let home = "", base = "", child: ChildProcess, stderr = "";
async function api(method: string, path: string, body?: unknown) {
  const response = await fetch(base + path, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json() as any };
}
beforeEach(async () => {
  stderr = "";
  home = mkdtempSync(join(tmpdir(), "omb-unavailable-fixture-"));
  const data = join(home, ".openmausbot"), staticDir = join(home, "static");
  mkdirSync(data); mkdirSync(staticDir);
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>Unavailable fixture</title>");
  writeFileSync(join(data, "config.json"), JSON.stringify({ instances: {
    codex: { driver: "codex", config: { cli: join(root, "server/testing/fake-codex-app-server.ts") },
      environment: { FAKE_CODEX_MODE: "happy", FAKE_CODEX_REFUSE_MODEL: "gpt-page-two" } },
  } }));
  const port = await freePortBlock([0, 1]); base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [join(root, "server/index.ts")], { cwd: root,
    env: { PATH: compatEnv.PATH, HOME: home, USERPROFILE: home, OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1), OMB_STATIC_DIR: staticDir, BOS_NO_MANAGED_CODEX: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  child.stderr!.on("data", chunk => { stderr += chunk; });
  const deadline = Date.now() + 20_000;
  while (true) {
    if (child.exitCode !== null) throw new Error(`fixture exited: ${stderr}`);
    try { if ((await fetch(base + "/api/health")).ok) break; } catch { /* fixture boot */ }
    if (Date.now() > deadline) throw new Error(stderr || "fixture start timeout");
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}, 30_000);
afterEach(async () => { if (child) await waitForExit(child, { signal: "SIGTERM" }); if (home) await removeTempDir(home); });

it("the real server answers on the account's model instead of surfacing the refusal", async () => {
  const created = await api("POST", "/api/bots", { name: "Fixture", modelSelection: { instanceId: "codex", model: "gpt-page-two" } });
  expect(created.status).toBe(201);
  const bot = created.body.bot;
  await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false });
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "fixture request", threadId: bot.threadId })).status).toBe(202);
  let state: any;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    state = (await api("GET", "/api/bots")).body.bots.find((candidate: any) => candidate.id === bot.id);
    const events = (() => { try { return readFileSync(join(home, ".openmausbot/events", `${bot.threadId}.ndjson`), "utf8"); } catch { return ""; } })();
    if (!state.tasks[0].busy && events.split("\n").filter(line => line.includes('"turn.completed"')).length >= 2) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  expect(state.modelSelection.model).toBe("gpt-fake-default");
  expect(state.tasks[0].modelSelection.model).toBe("gpt-fake-default");
  const events = readFileSync(join(home, ".openmausbot/events", `${bot.threadId}.ndjson`), "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(events.filter(e => e.type === "model.switched").map(e => [e.from, e.to, e.reason])).toEqual([["gpt-page-two", "gpt-fake-default", "model_unavailable"]]);
  expect(events.filter(e => e.type === "turn.started")).toHaveLength(2);
  expect(events.filter(e => e.type === "turn.completed").at(-1)?.ok).toBe(true);
  const messages: any[] = state.messages ?? [];
  const activity = messages.filter(m => m.kind === "activity").map(m => m.tool?.name ?? "");
  expect(activity.some(name => name.startsWith("error:"))).toBe(false);
  expect(activity).toContain("gpt-page-two is not on this account; switched to gpt-fake-default");
}, 40_000);
