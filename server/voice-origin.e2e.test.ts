import { compatEnv } from "../electron/branding-env.cjs";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import { openSse } from "./testing/sse.ts";
import { VOICE_CALL_HINT } from "./voice-origin.ts";

// A send spoken on a live voice call, end to end through the real server:
//
//   • the phone's `origin` rides the user message, and the bubble keeps the
//     caller's own words — only the model's prompt gains the one-line hint;
//   • when the turn that send started settles, the owner hears about it with
//     a voice_work_done push even though the bot's notifications are off,
//     because the caller may have hung up long ago;
//   • a send that waits behind a running turn keeps its origin through the
//     queue, and the turn it eventually starts is the one that pushes;
//   • a line steered into a running turn reaches the model hinted, and that
//     running turn is the one that pushes;
//   • ordinary sends are untouched: no hint, no voice push.
//
// The pure halves (validation, hint text, push payload) live in
// voice-origin.test.ts; this file pins the wiring around them.

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");

let child: ChildProcess;
let home = "";
let base = "";
let stderr = "";
let promptsFile = "";
let finishGate = "";
let steerFinishGate = "";
let toolResultGate = "";

const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: response.status === 204 ? null : await response.json() };
};

const botState = async (botId: string) =>
  (await api("GET", "/api/bots?messages=40")).body.bots.find((candidate: { id: string }) => candidate.id === botId);

const createBot = async (name: string, instanceId: string, notifications: boolean) => {
  const created = (await api("POST", "/api/bots", {})).body.bot;
  const patched = await api("PATCH", `/api/bots/${created.id}`, {
    name,
    notifications,
    modelSelection: { instanceId, model: "claude-fake" },
  });
  expect(patched.status).toBe(200);
  return patched.body.bot;
};

const removeBot = async (botId: string) => {
  await api("POST", `/api/bots/${botId}/interrupt`, {}).catch(() => undefined);
  await api("DELETE", `/api/bots/${botId}`).catch(() => undefined);
};

/** Every prompt the fake CLI was handed, oldest first. */
const prompts = (): string[] =>
  existsSync(promptsFile)
    ? readFileSync(promptsFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.stringify(JSON.parse(line)))
    : [];

const isVoicePush = (botId: string) => (frame: any) =>
  frame.kind === "notify" && frame.notification?.kind === "voice_work_done" && frame.notification?.botId === botId;

beforeAll(async () => {
  chmodSync(FAKE_CLAUDE, 0o755);
  home = mkdtempSync(join(tmpdir(), "omb-voice-origin-"));
  const data = join(home, ".openmausbot");
  mkdirSync(data, { recursive: true });
  promptsFile = join(home, "prompts.jsonl");
  finishGate = join(home, "finish.gate");
  steerFinishGate = join(home, "steer-finish.gate");
  toolResultGate = join(home, "tool-result.gate");
  writeFileSync(join(data, "config.json"), JSON.stringify({
    instances: {
      // answers at once; records every prompt so the hint can be read back
      quick: {
        driver: "claudeAgent",
        displayName: "Quick fixture",
        environment: { FAKE_CLAUDE_MODE: "happy", FAKE_CLAUDE_PROMPTS: promptsFile },
        config: { cli: FAKE_CLAUDE },
      },
      // holds each turn open until the gate file exists, so a second send
      // has to wait in the queue; its reply echoes the prompt it was given
      slow: {
        driver: "claudeAgent",
        displayName: "Slow fixture",
        environment: { FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: finishGate },
        config: { cli: FAKE_CLAUDE, permissionMode: "bypassPermissions" },
      },
      // the same, plus a held tool result: the gap an explicit steer lands in
      steerable: {
        driver: "claudeAgent",
        displayName: "Steerable fixture",
        environment: { FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: steerFinishGate, FAKE_CLAUDE_TOOL_RESULT_GATE: toolResultGate },
        config: { cli: FAKE_CLAUDE, permissionMode: "bypassPermissions" },
      },
    },
  }));
  const port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: ROOT,
    env: {
      ...(compatEnv.PATH ? { PATH: compatEnv.PATH } : {}),
      ...(compatEnv.SystemRoot ? { SystemRoot: compatEnv.SystemRoot } : {}),
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(port),
      OMB_WEBHOOK_PORT: String(port + 1),
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
}, 45_000);

afterAll(async () => {
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  if (home) await removeTempDir(home);
});

describe("a send from a live voice call", () => {
  it("stores the origin, hints the model, and pushes when done with notifications off", async () => {
    const bot = await createBot("Caller", "quick", false);
    const stream = await openSse(`${base}/api/events`);
    try {
      const origin = { kind: "voice_call", callId: "call-e2e-1", job: "Check how many bots are online." };
      const sent = await api("POST", `/api/bots/${bot.id}/messages`, { text: "how many bots are online right now", origin });
      expect(sent.status).toBe(202);

      const frame = await stream.until(isVoicePush(bot.id), 20_000);
      expect(frame.notification).toMatchObject({
        kind: "voice_work_done",
        botId: bot.id,
        threadId: bot.threadId,
        title: "Caller is done",
        callId: "call-e2e-1",
      });
      expect(frame.notification.body).toContain("hello from fake claude");

      await expect.poll(async () => (await botState(bot.id))?.busy, { timeout: 20_000 }).toBe(false);
      const messages = (await botState(bot.id)).messages;
      const asked = messages.filter((message: any) => message.role === "user" && message.kind === "text");
      // the bubble is the caller's words, once, with the origin beside them
      expect(asked).toHaveLength(1);
      expect(asked[0].text).toBe("how many bots are online right now");
      expect(asked[0].origin).toEqual(origin);
      // the push points at the settled reply, which the phone opens
      const reply = messages.find((message: any) => message.id === frame.notification.messageId);
      expect(reply).toMatchObject({ role: "bot", kind: "text" });
      expect(reply.text).toContain("hello from fake claude");

      // the model, and only the model, was told the answer is read out
      const sentToModel = prompts().filter((prompt) => prompt.includes("how many bots are online right now"));
      expect(sentToModel).toHaveLength(1);
      expect(sentToModel[0]).toContain(VOICE_CALL_HINT);
      expect(asked[0].text).not.toContain(VOICE_CALL_HINT);

      // one ask, one push; the bot's own (off) switch raised nothing else
      expect(stream.frames.filter(isVoicePush(bot.id))).toHaveLength(1);
      expect(stream.frames.filter((candidate) =>
        candidate.kind === "notify" && candidate.notification?.botId === bot.id && candidate.notification?.kind === "done")).toHaveLength(0);
    } finally {
      stream.close();
      await removeBot(bot.id);
    }
  }, 40_000);

  it("leaves an ordinary send alone: no hint, no voice push", async () => {
    const bot = await createBot("Plain", "quick", true);
    const stream = await openSse(`${base}/api/events`);
    try {
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "plain words, typed" })).status).toBe(202);
      const done = await stream.until(
        (candidate) => candidate.kind === "notify" && candidate.notification?.kind === "done" && candidate.notification?.botId === bot.id,
        20_000,
      );
      expect(done.notification.title).toBe("Plain finished");
      expect(stream.frames.filter(isVoicePush(bot.id))).toHaveLength(0);
      const sentToModel = prompts().filter((prompt) => prompt.includes("plain words, typed"));
      expect(sentToModel).toHaveLength(1);
      expect(sentToModel[0]).not.toContain(VOICE_CALL_HINT);
      const asked = (await botState(bot.id)).messages.find((message: any) => message.text === "plain words, typed");
      expect(asked.origin).toBeUndefined();
    } finally {
      stream.close();
      await removeBot(bot.id);
    }
  }, 40_000);

  it("refuses a malformed origin before anything reaches the thread", async () => {
    const bot = await createBot("Strict", "quick", false);
    try {
      const refusals = [
        { kind: "phone_call", callId: "c1" },
        { kind: "voice_call" },
        { kind: "voice_call", callId: "" },
        { kind: "voice_call", callId: "x".repeat(129) },
        { kind: "voice_call", callId: "c1", job: "y".repeat(2001) },
        { kind: "voice_call", callId: "c1", job: 7 },
        "voice_call",
      ];
      for (const origin of refusals) {
        const sent = await api("POST", `/api/bots/${bot.id}/messages`, { text: "should never land", origin });
        expect(sent.status, JSON.stringify(origin)).toBe(400);
        expect(sent.body.error).toMatch(/origin/);
      }
      expect((await botState(bot.id)).messages.some((message: any) => message.text === "should never land")).toBe(false);
      // the limits themselves are accepted
      const atLimit = await api("POST", `/api/bots/${bot.id}/messages`, {
        text: "at the limit",
        origin: { kind: "voice_call", callId: "x".repeat(128), job: "y".repeat(2000) },
      });
      expect(atLimit.status).toBe(202);
    } finally {
      await removeBot(bot.id);
    }
  }, 40_000);

  it("keeps the origin on a send queued behind a running turn, and pushes for that turn only", async () => {
    rmSync(finishGate, { force: true });
    const bot = await createBot("Queuer", "slow", true);
    const stream = await openSse(`${base}/api/events`);
    try {
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "typed first" })).status).toBe(202);
      await expect.poll(async () => (await botState(bot.id))?.busy, { timeout: 20_000 }).toBe(true);

      const origin = { kind: "voice_call", callId: "call-e2e-queued" };
      const queued = await api("POST", `/api/bots/${bot.id}/messages`, { text: "then this, said out loud", origin });
      expect(queued.status).toBe(202);
      expect(queued.body).toMatchObject({ ok: true, queued: true });

      writeFileSync(finishGate, "finish");
      const frame = await stream.until(isVoicePush(bot.id), 30_000);
      expect(frame.notification).toMatchObject({ title: "Queuer is done", callId: "call-e2e-queued", threadId: bot.threadId });

      await expect.poll(async () => (await botState(bot.id))?.busy, { timeout: 20_000 }).toBe(false);
      const messages = (await botState(bot.id)).messages;
      const voiceAsk = messages.find((message: any) => message.role === "user" && message.text === "then this, said out loud");
      expect(voiceAsk.origin).toEqual(origin);
      expect(messages.find((message: any) => message.text === "typed first").origin).toBeUndefined();

      // the push names the queued ask's own reply, and that reply was
      // written for a prompt carrying the hint; the typed turn's was not
      const reply = messages.find((message: any) => message.id === frame.notification.messageId);
      expect(reply.text).toContain("then this, said out loud");
      expect(reply.text).toContain(VOICE_CALL_HINT);
      const typedReply = messages.find((message: any) => message.role === "bot" && message.text?.startsWith("reply to: typed first"));
      expect(typedReply.text).not.toContain(VOICE_CALL_HINT);

      // the typed turn buzzed as usual; the voice turn buzzed once, as voice
      expect(stream.frames.filter(isVoicePush(bot.id))).toHaveLength(1);
      expect(stream.frames.filter((candidate) =>
        candidate.kind === "notify" && candidate.notification?.botId === bot.id && candidate.notification?.kind === "done")).toHaveLength(1);
    } finally {
      stream.close();
      rmSync(finishGate, { force: true });
      await removeBot(bot.id);
    }
  }, 60_000);
  it("folds a steered voice line into the running turn with the hint, and that turn pushes", async () => {
    rmSync(steerFinishGate, { force: true });
    writeFileSync(toolResultGate, "hold the tool result");
    const bot = await createBot("Steery", "steerable", false);
    const stream = await openSse(`${base}/api/events`);
    try {
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "typed opener" })).status).toBe(202);
      await expect.poll(async () => (await botState(bot.id))?.messages.some((message: any) => message.kind === "activity"), { timeout: 20_000 }).toBe(true);

      const origin = { kind: "voice_call", callId: "call-e2e-steered" };
      const queued = await api("POST", `/api/bots/${bot.id}/messages`, { text: "and say it back to me", origin });
      expect(queued.status).toBe(202);
      let steered: { status: number; body: any };
      try {
        steered = await api("POST", `/api/bots/${bot.id}/queue/${queued.body.queueId}/steer`, { threadId: queued.body.threadId });
      } finally {
        writeFileSync(steerFinishGate, "finish");
      }
      expect(steered.status).toBe(200);
      expect(steered.body).toMatchObject({ ok: true, steered: true });
      rmSync(toolResultGate, { force: true });

      const frame = await stream.until(isVoicePush(bot.id), 30_000);
      expect(frame.notification).toMatchObject({ title: "Steery is done", callId: "call-e2e-steered" });
      await expect.poll(async () => (await botState(bot.id))?.busy, { timeout: 20_000 }).toBe(false);
      const messages = (await botState(bot.id)).messages;
      const line = messages.find((message: any) => message.role === "user" && message.text === "and say it back to me");
      expect(line).toMatchObject({ steered: true, origin });
      // one turn: its reply carries the steered words, hinted for the model
      const reply = messages.find((message: any) => message.id === frame.notification.messageId);
      expect(reply.text).toMatch(/^reply to: typed opener \+ steered: /);
      expect(reply.text).toContain(VOICE_CALL_HINT);
      expect(stream.frames.filter(isVoicePush(bot.id))).toHaveLength(1);
    } finally {
      stream.close();
      rmSync(steerFinishGate, { force: true });
      rmSync(toolResultGate, { force: true });
      await removeBot(bot.id);
    }
  }, 60_000);
});
