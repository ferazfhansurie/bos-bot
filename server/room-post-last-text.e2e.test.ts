import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

// A room member's turn often says something, runs tools, then answers. Only
// the answer is the room post; the earlier text stays readable as an activity
// row. Gluing every text of the turn into one post is how a brief once showed
// up three times in a room.

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");

const COMMENTARY = "checking the build first.";
const ANSWER = "@Bee build is green, take the deploy.";

let child: ChildProcess;
let home = "";
let base = "";
let stderr = "";
let beeDump = "";

type StateMessage = {
  id: string;
  kind: string;
  role?: string;
  text?: string;
  turnTerminal?: boolean;
  from?: { botId?: string; name?: string };
  tool?: { name?: string; ok?: boolean; output?: unknown };
};

const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
};

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "omb-room-post-last-text-"));
  const data = join(home, ".openmausbot");
  const staticDir = join(home, "static");
  mkdirSync(data, { recursive: true });
  mkdirSync(join(staticDir, "assets"), { recursive: true });
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>Room post test</title>");
  writeFileSync(join(staticDir, "assets", "smoke.css"), "body{}");
  beeDump = join(home, "bee-dump.json");
  writeFileSync(join(data, "config.json"), JSON.stringify({
    instances: {
      talker: {
        driver: "claudeAgent",
        displayName: "Text, tool, text fixture",
        environment: {
          FAKE_CLAUDE_MODE: "happy",
          FAKE_CLAUDE_REPLIES: JSON.stringify([[COMMENTARY, ANSWER]]),
          FAKE_CLAUDE_REPLY_STATE: join(home, "talker-replies.txt"),
          FAKE_CLAUDE_TOOL_CALLS: JSON.stringify([{ name: "Bash", input: { command: "pnpm test" }, output: "ok" }]),
          FAKE_CLAUDE_TEXT_BEFORE_TOOLS: "1",
        },
        config: { cli: FAKE_CLAUDE },
      },
      quick: { driver: "claudeAgent", displayName: "Quick fixture", environment: { FAKE_CLAUDE_MODE: "happy", FAKE_CLAUDE_DUMP: beeDump }, config: { cli: FAKE_CLAUDE } },
    },
  }));
  const port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: ROOT,
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(port),
      OMB_WEBHOOK_PORT: String(port + 1),
      OMB_STATIC_DIR: staticDir,
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
      // Still starting.
    }
    if (Date.now() >= deadline) throw new Error(`server never became healthy: ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}, 30_000);

afterAll(async () => {
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  if (home) await removeTempDir(home);
});

const createBot = async (name: string, instanceId: string) =>
  (await api("POST", "/api/bots", { name, modelSelection: { instanceId, model: "claude-sonnet-5" }, requireAvailableModel: true })).body.bot;

const roomMessages = async (groupId: string): Promise<StateMessage[]> => {
  const state = (await api("GET", "/api/bots?messages=40")).body;
  return state.groups.find((group: { id: string }) => group.id === groupId)?.messages ?? [];
};

it("posts only a room turn's last text when it goes text, tool call, text", async () => {
  const ace = await createBot("Ace", "talker");
  const bee = await createBot("Bee", "quick");
  const room = (await api("POST", "/api/groups", {
    name: "Post shape",
    memberIds: [ace.id, bee.id],
    setup: { bulletin: "", defaultResponder: { kind: "everyone" } },
  })).body.group;

  expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "@Ace is the build ok?" })).status).toBe(202);
  // Bee answering proves the mention in Ace's last text still routes.
  await expect.poll(async () => (await roomMessages(room.id)).some((m) => m.kind === "text" && m.from?.botId === bee.id), { timeout: 20_000 }).toBe(true);

  const messages = await roomMessages(room.id);
  const acePosts = messages.filter((m) => m.role === "bot" && m.kind === "text" && m.from?.botId === ace.id);
  expect(acePosts.map((m) => m.text)).toEqual([ANSWER]);
  expect(acePosts[0]!.turnTerminal).toBe(true);
  // The commentary is still there to read, as working activity.
  const commentary = messages.find((m) => m.kind === "activity" && m.from?.botId === ace.id && m.tool?.output === COMMENTARY);
  expect(commentary?.tool?.name).toBe(COMMENTARY);
  // Nothing in the room repeats the commentary as a post of its own.
  expect(messages.filter((m) => m.kind === "text" && (m.text ?? "").includes(COMMENTARY))).toEqual([]);
  // What Bee was handed is the answer, not the answer glued to the commentary.
  const beePrompt = JSON.stringify(JSON.parse(readFileSync(beeDump, "utf8")).prompt);
  expect(beePrompt).toContain("build is green");
  expect(beePrompt).not.toContain(COMMENTARY);
}, 45_000);
