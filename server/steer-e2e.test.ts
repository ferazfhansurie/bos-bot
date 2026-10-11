import { compatEnv } from "../electron/branding-env.cjs";
// Mid-turn steering, end to end: boots the real harness with the fake claude
// CLI in `slow` mode (a gap after the tool result the way a real turn has
// between model calls), sends a message WHILE the turn runs, and asserts
// an explicit queue steer takes it into the turn — 200 steered; in the transcript in order and
// marked; folded into the reply — while an engine without a live session
// falls back to the server-side queue.
//
// POSIX-gated like the other CLI e2es (the fakes are shebang scripts).
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BUILT_IN_DRIVERS } from "./drivers/builtIn.ts";

const acpAvailable = BUILT_IN_DRIVERS.some(driver => driver.driverKind === "grokAgent");
const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const FAKE_ACP = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const FAKE_CODEX = join(SERVER_DIR, "testing", "fake-codex-app-server.ts");
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const posixOnly = describe.skipIf(process.platform === "win32");

posixOnly("mid-turn steering e2e", () => {
  let child: ChildProcess;
  let home: string;
  let stderr = "";
  let steerGate: string;
  let steerFinishGate: string;
  let toolResultGate: string;
  let codexSteerGate: string;

  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  /** Tests opting into live delivery enqueue first, then call the explicit
   * steer endpoint. Keep its HTTP status and messages[]; expose the first
   * message and original queueId as test-only conveniences for replay checks. */
  const enqueueThenSteer = async (path: string, body: { text: string; threadId?: string; sendId?: string }) => {
    const queued = await api("POST", path, body);
    expect(queued.status).toBe(202);
    expect(queued.body).toMatchObject({ ok: true, queued: true });
    expect(queued.body.steered).not.toBe(true);
    const result = await api("POST", path.replace(/\/messages$/, `/queue/${queued.body.queueId}/steer`), {
      threadId: body.threadId ?? queued.body.threadId,
    });
    return { ...result, body: { ...result.body, queueId: queued.body.queueId, message: result.body.messages?.[0] } };
  };
  const getBot = async (id: string) => (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === id);
  const waitFor = async (predicate: () => Promise<boolean>, what: string, ms = 30_000) => {
    const deadline = Date.now() + ms;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}. stderr: ${stderr.slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  beforeAll(async () => {
    chmodSync(FAKE_CLAUDE, 0o755);
    chmodSync(FAKE_ACP, 0o755);
    chmodSync(FAKE_CODEX, 0o755);
    home = mkdtempSync(join(tmpdir(), "omb-steer-"));
    mkdirSync(join(home, ".openmausbot"), { recursive: true });
    toolResultGate = join(home, "tool-result.gate");
    steerGate = join(home, "delayed-steer.gate");
    steerFinishGate = join(home, "finish-steered-turn.gate");
    codexSteerGate = join(home, "codex-steer-refused.gate");
    writeFileSync(codexSteerGate, "refuse live steers until the queue test clears this gate");
    writeFileSync(
      join(home, ".openmausbot", "config.json"),
      JSON.stringify({
        instances: {
          claude: { driver: "claudeAgent", environment: { FAKE_CLAUDE_MODE: "slow" }, config: { cli: FAKE_CLAUDE, permissionMode: "bypassPermissions" } },
          claudeSteer: {
            driver: "claudeAgent",
            environment: { FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: steerFinishGate, FAKE_CLAUDE_TOOL_RESULT_GATE: toolResultGate },
            config: { cli: FAKE_CLAUDE, permissionMode: "bypassPermissions" },
          },
          claudeRace: {
            driver: "claudeAgent",
            environment: { FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_STEER_GATE: steerGate },
            config: { cli: FAKE_CLAUDE, permissionMode: "bypassPermissions" },
          },
          // no live session: a message while busy uses the server-side queue
          acp: { driver: "grokAgent", environment: { FAKE_ACP_MODE: "hang" }, config: { cli: FAKE_ACP, fullAuto: true } },
          // codex parks its turn on an unanswered question; turn/steer folds
          // new input into that live turn without ending it
          codex: { driver: "codex", environment: { FAKE_CODEX_MODE: "question", FAKE_CODEX_ASK_HOLD: "1" }, config: { cli: FAKE_CODEX } },
          codexUnknown: {
            driver: "codex",
            environment: { FAKE_CODEX_MODE: "question", FAKE_CODEX_ASK_HOLD: "1", FAKE_CODEX_STEER_HANG: "1", FAKE_CODEX_STEER_TIMEOUT_MS: "150" },
            config: { cli: FAKE_CODEX },
          },
          codexRace: {
            driver: "codex",
            environment: {
              FAKE_CODEX_MODE: "question",
              FAKE_CODEX_ASK_HOLD: "1",
              FAKE_CODEX_STEER_ERROR_FILE: codexSteerGate,
            },
            config: { cli: FAKE_CODEX },
          },
        },
      }),
    );
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: { ...(compatEnv.PATH ? { PATH: compatEnv.PATH } : {}), HOME: home, USERPROFILE: home, OMB_PORT: String(PORT) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (c) => (stderr += c));
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        if ((await fetch(`${BASE}/api/health`)).ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }, 30_000);

  afterAll(async () => {
    child?.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (!child || child.exitCode !== null) return resolve();
      child.on("close", () => resolve());
      setTimeout(() => (child.kill("SIGKILL"), resolve()), 5_000).unref?.();
    });
    rmSync(home, { recursive: true, force: true });
  });

  it("interrupts an explicitly steered phone correction before the held tool returns", async () => {
    writeFileSync(toolResultGate, "hold result");
    rmSync(steerFinishGate, { force: true });
    const created = (await api("POST", "/api/bots")).body.bot;
    try {
      await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId: "claudeSteer", model: "claude-fake" } });
      await api("POST", `/api/bots/${created.id}/messages`, { text: "original work" });
      await waitFor(async () => (await getBot(created.id)).messages.some((m: any) => m.kind === "activity"), "held tool");
      const queued = await api("POST", `/api/bots/${created.id}/messages`, { text: "correct course now", sendId: "immediate-steer-once" });
      expect(queued.body.queued).toBe(true);
      const receipt = await api("POST", `/api/bots/${created.id}/queue/${queued.body.queueId}/steer`, { threadId: created.threadId, interrupt: true });
      expect(receipt.status).toBe(200);
      expect(receipt.body).toMatchObject({ interrupted: true, queued: false, threadId: created.threadId });
      expect(receipt.body.messages).toHaveLength(1);
      expect(receipt.body.messages[0]).toMatchObject({ text: "correct course now", sendId: "immediate-steer-once" });
      expect(readFileSync(toolResultGate, "utf8")).toBe("hold result");
      const repeated = await api("POST", `/api/bots/${created.id}/queue/${queued.body.queueId}/steer`, { threadId: created.threadId, interrupt: true });
      expect(repeated.body.interrupted).not.toBe(true);
      const snapshot = await getBot(created.id);
      expect(snapshot.messages.filter((m: any) => m.sendId === "immediate-steer-once")).toHaveLength(1);
    } finally {
      await api("POST", `/api/bots/${created.id}/stop`, { threadId: created.threadId });
      rmSync(toolResultGate, { force: true });
      writeFileSync(steerFinishGate, "finish");
    }
  }, 30_000);

  it(
    "explicitly steers a queued send into the same Claude turn with no remaining queued chip",
    async () => {
      rmSync(steerFinishGate, { force: true });
      writeFileSync(toolResultGate, "hold result");
      const created = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId: "claudeSteer", model: "claude-fake" } });
      const instances = (await api("GET", "/api/instances")).body.instances;
      expect(instances.find((i: any) => i.instanceId === "claudeSteer").capabilities.queueing).toBe(true);

      expect((await api("POST", `/api/bots/${created.id}/messages`, { text: "first" })).status).toBe(202);
      await waitFor(async () => (await getBot(created.id)).busy === true, "the turn to start");
      // the fake pauses after its tool result; this lands inside that gap
      await waitFor(async () => (await getBot(created.id)).messages.some((m: any) => m.kind === "activity"), "the tool chip");
      let second: Awaited<ReturnType<typeof api>>;
      try {
        second = await enqueueThenSteer(`/api/bots/${created.id}/messages`, { text: "and also this" });
      } finally {
        writeFileSync(steerFinishGate, "finish");
      }
      expect(second.status).toBe(200);
      expect(second.body).toMatchObject({ ok: true, steered: true });
      expect(second.body.message.steerDelivery).toBe("transport_written");
      expect(second.body.queued).toBeUndefined();
      expect((await getBot(created.id)).messages.filter((m: any) => m.text === "and also this" && m.steered)).toHaveLength(1);
      // no chip left behind: the queue id is already settled
      expect((await api("POST", `/api/bots/${created.id}/queue/${second.body.message.queueId}/steer`, { threadId: created.threadId })).body.queued).not.toBe(true);
      rmSync(toolResultGate, { force: true });

      await waitFor(async () => (await getBot(created.id)).busy === false, "the turn to settle");
      const bot = await getBot(created.id);
      const texts = bot.messages.filter((m: any) => m.kind === "text").map((m: any) => `${m.role}:${m.text}`);
      // order: greeting, first, the fake's opening line, the steered message
      // (appended by explicit Steer mid-turn), then ONE reply carrying it
      expect(texts.slice(1)).toEqual([
        "user:first",
        "bot:hello from fake claude",
        "user:and also this",
        "bot:reply to: first + steered: and also this",
      ]);
      const steered = bot.messages.find((m: any) => m.text === "and also this");
      expect(steered.steered).toBe(true);
      // one turn, not two: exactly one reply
      expect(bot.messages.filter((m: any) => m.role === "bot" && m.kind === "text" && m.text.startsWith("reply to:"))).toHaveLength(1);
      // the tool chip keeps its command after the result settles it — the
      // completion patch replaces the whole tool object
      const chip = bot.messages.find((m: any) => m.kind === "activity" && m.tool?.name === "Bash");
      expect(chip.tool).toMatchObject({ ok: true, summary: "echo hi" });
    },
    40_000,
  );

  it("explicitly steers queued room messages to the addressed member once each", async () => {
    rmSync(steerFinishGate, { force: true });
    writeFileSync(toolResultGate, "hold the room member's tool result");
    const created = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${created.id}`, {
      name: "dev", modelSelection: { instanceId: "claudeSteer", model: "claude-fake" },
    });
    const room = (await api("POST", "/api/groups", {
      name: "Room tool boundary", memberIds: [created.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: created.id } },
    })).body.group;
    const getRoom = async () => (await api("GET", "/api/bots")).body.groups.find((g: any) => g.id === room.id);
    const pasted = '@dev correction\n\n<pasted-text index="1">\nFULL PASTED INPUT\nsecond line\n</pasted-text>';
    const aside = "also preserve the user's second message";
    try {
      await api("POST", `/api/groups/${room.id}/messages`, { text: "@dev start" });
      await waitFor(async () => (await getRoom()).messages.some((m: any) => m.tool?.name === "Bash" && m.tool.ok === undefined), "the held room tool");
      const body = { text: pasted, sendId: "room-boundary-paste" };
      const [first, retry] = await Promise.all([
        api("POST", `/api/groups/${room.id}/messages`, body),
        api("POST", `/api/groups/${room.id}/messages`, body),
      ]);
      expect(first.body).toMatchObject({ ok: true, queued: true });
      expect(retry.body.queueId).toBe(first.body.queueId);
      const firstSteer = await api("POST", `/api/groups/${room.id}/queue/${first.body.queueId}/steer`, { threadId: room.threadId });
      expect(firstSteer.body).toMatchObject({ ok: true, steered: true });
      expect(firstSteer.body.messages).toHaveLength(1);
      const second = await enqueueThenSteer(`/api/groups/${room.id}/messages`, { text: aside, sendId: "room-boundary-aside" });
      expect(second.body).toMatchObject({ ok: true, steered: true });
      expect((await getRoom()).messages.filter((m: any) => m.text === pasted && m.steered)).toHaveLength(1);
      rmSync(toolResultGate, { force: true });
      expect((await getRoom()).working).toBe(true);
      for (const queueId of [first.body.queueId, second.body.message.queueId]) {
        expect((await api("POST", `/api/groups/${room.id}/queue/${queueId}/steer`, { botId: created.id })).status).toBe(404);
      }
      writeFileSync(steerFinishGate, "finish");
      await waitFor(async () => !(await getRoom()).working, "the corrected room turn to settle");
      const messages = (await getRoom()).messages;
      for (const text of [pasted, aside]) {
        expect(messages.filter((m: any) => m.role === "user" && m.text === text)).toHaveLength(1);
        expect(messages.find((m: any) => m.text === text).steerDelivery).toBe("transport_written");
      }
      const replies = messages.filter((m: any) => m.role === "bot" && m.kind === "text" && m.turnTerminal);
      expect(replies).toHaveLength(1);
      expect(replies[0].text).toContain("FULL PASTED INPUT\nsecond line");
      expect(replies[0].text).toContain(aside);
    } finally {
      rmSync(toolResultGate, { force: true });
      writeFileSync(steerFinishGate, "release fixture");
      await api("POST", `/api/groups/${room.id}/interrupt`, {});
    }
  }, 40_000);

  it("steers two attachment messages into the running turn as native images, once each", async () => {
    const created = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${created.id}`, {
      modelSelection: { instanceId: "claude", model: "claude-fake" },
    });
    expect((await api("POST", `/api/bots/${created.id}/messages`, { text: "first image task" })).status)
      .toBe(202);
    await waitFor(async () => (await getBot(created.id)).busy === true, "the image queue turn to start");
    await waitFor(
      async () => (await getBot(created.id)).messages.some((message: any) => message.kind === "activity"),
      "the image queue tool chip",
    );

    const attachments = join(home, ".openmausbot", "attachments");
    mkdirSync(attachments, { recursive: true });
    const firstImagePath = join(attachments, "123e4567-e89b-42d3-a456-426614174000.png");
    const secondImagePath = join(attachments, "123e4567-e89b-42d3-a456-426614174001.png");
    writeFileSync(firstImagePath, "first png");
    writeFileSync(secondImagePath, "second png");
    const firstAttachedText = `look at this\n\n<attached-image path="${firstImagePath}" name="first.png" />`;
    const secondAttachedText = `and this\n\n<attached-image path="${secondImagePath}" name="second.png" />`;
    const firstReceipt = await enqueueThenSteer(`/api/bots/${created.id}/messages`, { text: firstAttachedText });
    const secondReceipt = await enqueueThenSteer(`/api/bots/${created.id}/messages`, { text: secondAttachedText });

    expect(firstReceipt.status).toBe(200);
    expect(firstReceipt.body).toMatchObject({ ok: true, steered: true });
    expect(secondReceipt.status).toBe(200);
    expect(secondReceipt.body).toMatchObject({ ok: true, steered: true });
    const sent = (await getBot(created.id)).messages;
    for (const text of [firstAttachedText, secondAttachedText]) {
      expect(sent.filter((message: any) => message.role === "user" && message.text === text)).toHaveLength(1);
    }
    for (const receipt of [firstReceipt, secondReceipt]) {
      expect((await api("POST", `/api/bots/${created.id}/queue/${receipt.body.message.queueId}/steer`, { threadId: created.threadId })).body.queued).not.toBe(true);
    }
    await waitFor(async () => (await getBot(created.id)).busy === false, "the image-steered turn to settle");

    const nativeRows = readFileSync(
      join(home, ".openmausbot", "native", `${created.threadId}.ndjson`),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const steers = nativeRows
      .filter((row) => row.dir === "out" && row.source === "claude.sdk.message")
      .slice(-2).map((row) => row.msg.message.content);
    expect(steers).toEqual([
      [
        { type: "image", source: { type: "base64", media_type: "image/png", data: "[image data: 12 base64 chars]" } },
        { type: "text", text: "look at this\n\n" },
      ],
      [
        { type: "image", source: { type: "base64", media_type: "image/png", data: "[image data: 16 base64 chars]" } },
        { type: "text", text: "and this\n\n" },
      ],
    ]);
  }, 40_000);

  it("steers a pasted image into the running Claude turn as a native image, and says when one cannot go", async () => {
    rmSync(steerFinishGate, { force: true });
    rmSync(toolResultGate, { force: true });
    const created = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId: "claudeSteer", model: "claude-fake" } });
    expect((await api("POST", `/api/bots/${created.id}/messages`, { text: "first" })).status).toBe(202);
    await waitFor(async () => (await getBot(created.id)).messages.some((m: any) => m.kind === "activity" && m.tool?.name === "Bash"), "the tool chip");

    const attachments = join(home, ".openmausbot", "attachments");
    mkdirSync(attachments, { recursive: true });
    const imagePath = join(attachments, "123e4567-e89b-42d3-a456-426614174010.png");
    writeFileSync(imagePath, "steered pixels");
    const missingPath = join(attachments, "123e4567-e89b-42d3-a456-426614174011.png");
    try {
      const imageText = `look at this\n\n<attached-image path="${imagePath}" name="shot.png" />`;
      const steered = await enqueueThenSteer(`/api/bots/${created.id}/messages`, { text: imageText });
      expect(steered.body).toMatchObject({ steered: true });
      expect((await getBot(created.id)).messages.find((m: any) => m.text === imageText)?.steered).toBe(true);
      const outgoing = readFileSync(join(home, ".openmausbot", "native", `${created.threadId}.ndjson`), "utf8")
        .trim().split("\n").map((line) => JSON.parse(line))
        .filter((row) => row.dir === "out" && row.source === "claude.sdk.message").at(-1)?.msg;
      expect(outgoing.message.content).toEqual([
        { type: "image", source: { type: "base64", media_type: "image/png", data: "[image data: 20 base64 chars]" } },
        { type: "text", text: "look at this\n\n" },
      ]);

      // A tag whose file is gone keeps the words moving and says so.
      const missingText = `and this one\n\n<attached-image path="${missingPath}" name="gone.png" />`;
      const missingSteer = await enqueueThenSteer(`/api/bots/${created.id}/messages`, { text: missingText });
      expect(missingSteer.body).toMatchObject({ steered: true });
      const notes = (await getBot(created.id)).messages.filter((m: any) => m.kind === "activity" && m.tool?.name.startsWith("image not delivered"));
      expect(notes.map((m: any) => m.tool.name)).toEqual(["image not delivered: gone.png — the attachment file is missing"]);
    } finally {
      writeFileSync(steerFinishGate, "finish");
    }
    await waitFor(async () => (await getBot(created.id)).busy === false, "the image-steered turn to settle");
    const replies = (await getBot(created.id)).messages.filter((m: any) => m.role === "bot" && m.kind === "text" && m.text.startsWith("reply to:"));
    expect(replies).toHaveLength(1);
    expect(replies[0].text).toContain("steered: [image image/png steered pixels] look at this");
  }, 40_000);

  it("a room steer carries a pasted image into the running Claude member turn", async () => {
    rmSync(steerFinishGate, { force: true });
    rmSync(toolResultGate, { force: true });
    const created = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId: "claudeSteer", model: "claude-fake" } });
    const room = (await api("POST", "/api/groups", {
      name: "Image steer room",
      memberIds: [created.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: created.id } },
    })).body.group;
    const getGroup = async () =>
      (await api("GET", "/api/bots?messages=60")).body.groups.find((g: any) => g.id === room.id);
    const imagePath = join(home, ".openmausbot", "attachments", "123e4567-e89b-42d3-a456-426614174012.png");
    mkdirSync(dirname(imagePath), { recursive: true });
    writeFileSync(imagePath, "room pixels");
    try {
      expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "first room turn" })).status).toBe(202);
      await waitFor(async () => (await getGroup())?.messages.some((m: any) => m.kind === "activity" && m.tool?.name === "Bash"), "the room tool chip");
      const imageText = `check the screenshot\n\n<attached-image path="${imagePath}" name="room.png" />`;
      const steered = await enqueueThenSteer(`/api/groups/${room.id}/messages`, { text: imageText });
      expect(steered.body).toMatchObject({ ok: true, steered: true });
      expect((await getGroup())?.messages.find((m: any) => m.text === imageText)?.steered).toBe(true);
      const aliases = JSON.parse(readFileSync(join(home, ".openmausbot", "room-runtime-aliases.json"), "utf8"));
      const runtimeId = aliases.find(([, owner]: [string, { threadId: string; botId: string }]) => owner.threadId === room.threadId && owner.botId === created.id)?.[0];
      const outgoing = readFileSync(join(home, ".openmausbot", "native", `${runtimeId}.ndjson`), "utf8")
        .trim().split("\n").map((line) => JSON.parse(line))
        .filter((row) => row.dir === "out" && row.source === "claude.sdk.message").at(-1)?.msg;
      expect(outgoing.message.content[0]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "[image data: 16 base64 chars]" } });
      expect(outgoing.message.content.at(-1).text).toContain("check the screenshot");
      expect((await getGroup())?.messages.some((m: any) => m.tool?.name?.startsWith("image not delivered"))).toBe(false);
    } finally {
      writeFileSync(steerFinishGate, "finish");
    }
    await waitFor(async () => (await getGroup())?.working === false, "the image-steered room turn to settle");
    const reply = (await getGroup())?.messages.find((m: any) => m.role === "bot" && m.kind === "text" && m.text.startsWith("reply to:"));
    expect(reply?.text).toContain("[image image/png room pixels]");
  }, 40_000);

  // Unskipped 2026-09-16: the first CI run on the PR head (bbed1455, run
  // 35044994016) passed this test on all three OS legs, so the quarantine
  // condition (CI green) is met. The local failure stays recorded: the DELETE 503 is
  // browser-cleanup refusal (restart-the-desktop-app path) on a wedged
  // 900KB fake pipe — environmental on this machine, not the steer hold
  // logic. CI remains the judge.
  it("rejects a delayed steer acknowledgement after the bot is deleted", async () => {
    const created = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${created.id}`, {
      modelSelection: { instanceId: "claudeRace", model: "claude-fake" },
    });

    expect((await api("POST", `/api/bots/${created.id}/messages`, { text: "first race turn" })).status).toBe(202);
    await waitFor(async () => (await getBot(created.id))?.busy === true, "the race turn to start");
    await waitFor(
      async () => (await getBot(created.id))?.messages.some((message: any) => message.kind === "activity"),
      "the race turn tool chip",
    );

    // The fake has paused stdin after the first prompt. This exceeds a pipe's
    // writable buffer, so the steer promise cannot acknowledge until the gate
    // opens; meanwhile the first turn is free to settle normally.
    const delayed = enqueueThenSteer(`/api/bots/${created.id}/messages`, {
      text: `delayed ownership check ${"x".repeat(900_000)}`, threadId: created.threadId,
    });
    const prematurelySettled = await Promise.race([
      delayed.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    expect(prematurelySettled).toBe(false);

    await waitFor(async () => (await getBot(created.id))?.busy === false, "the original race turn to settle");
    expect((await api("DELETE", `/api/bots/${created.id}`)).status).toBe(200);
    writeFileSync(steerGate, "open");

    const rejected = await delayed;
    expect(rejected.status).toBe(404);
    expect(rejected.body.error).toMatch(/no such bot/i);
  }, 40_000);

  it.skipIf(!acpAvailable)("an engine without a live session preserves the message in the server-side queue", async () => {
    const created = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId: "acp", model: "fake-model" } });
    expect((await api("POST", `/api/bots/${created.id}/messages`, { text: "first" })).status).toBe(202);
    await waitFor(async () => (await getBot(created.id)).busy === true, "the hung turn to start");
    const queued = await api("POST", `/api/bots/${created.id}/messages`, { text: "second" });
    expect(queued.status).toBe(202);
    expect(queued.body.queued).toBe(true);
    expect((await getBot(created.id)).messages.some((m: any) => m.text === "second")).toBe(false);
    await api("POST", `/api/bots/${created.id}/interrupt`);
    await waitFor(
      async () => (await getBot(created.id)).messages.some((m: any) => m.text === "second"),
      "the queued message to begin its turn",
    );
    await api("POST", `/api/bots/${created.id}/interrupt`);
    await waitFor(async () => (await getBot(created.id)).busy === false, "the queued turn to settle");
  }, 30_000);

  it("a queued codex message is explicitly steered into the live turn via turn/steer, and Stop never reports SIGTERM", async () => {
    const created = (await api("POST", "/api/bots")).body.bot;
    const instances = (await api("GET", "/api/instances")).body.instances;
    const codexInstance = instances.find((i: any) => i.instanceId === "codex");
    expect(codexInstance.capabilities.queueing).toBe(true);
    await api("PATCH", `/api/bots/${created.id}`, {
      modelSelection: { instanceId: "codex", model: codexInstance.models.default },
    });

    expect((await api("POST", `/api/bots/${created.id}/messages`, { text: "first codex turn" })).status).toBe(202);
    await waitFor(async () => (await getBot(created.id)).busy === true, "the codex turn to start");
    // the unanswered question parks the turn mid-flight, like real work
    await waitFor(
      async () => (await getBot(created.id)).messages.some((m: any) => m.card),
      "the codex question card",
    );

    const second = await enqueueThenSteer(`/api/bots/${created.id}/messages`, { text: "and also this" });
    expect(second.status).toBe(200);
    expect(second.body.steered).toBe(true);
    expect(second.body).toMatchObject({ delivery: "provider_accepted", consumption: "unconfirmed" });
    const steered = (await getBot(created.id)).messages.find((m: any) => m.text === "and also this");
    expect(steered.steered).toBe(true);
    expect(steered.steerDelivery).toBe("provider_accepted");

    // the fold reached the app-server as mid-turn input for the SAME turn
    const nativeRows = readFileSync(join(home, ".openmausbot", "native", `${created.threadId}.ndjson`), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line));
    const steerRow = nativeRows.find((row) => row.dir === "out" && row.msg?.method === "turn/steer")?.msg;
    expect(steerRow?.params).toMatchObject({
      threadId: "codex-thread-1",
      input: [{ type: "text", text: "and also this" }],
      expectedTurnId: "turn-1",
    });

    const imagePath = join(home, ".openmausbot", "attachments", "123e4567-e89b-42d3-a456-426614174099.png");
    mkdirSync(dirname(imagePath), { recursive: true });
    writeFileSync(imagePath, "image steering fixture");
    for (const caption of ["look at this", ""]) {
      const text = `${caption}\n\n<attached-image path="${imagePath}" name="steer.png" />`;
      const imageReceipt = await enqueueThenSteer(`/api/bots/${created.id}/messages`, { text });
      expect(imageReceipt.status).toBe(200);
      expect(imageReceipt.body).toMatchObject({ steered: true });
      const rows = readFileSync(join(home, ".openmausbot", "native", `${created.threadId}.ndjson`), "utf8").trim().split("\n").map(line => JSON.parse(line));
      const call = rows.filter(row => row.dir === "out" && row.msg?.method === "turn/steer").at(-1)?.msg;
      expect(call.params.expectedTurnId).toBe("turn-1");
      expect(call.params.input.some((item: any) => item.type === "localImage")).toBe(true);
      expect(JSON.stringify(call)).not.toContain(imagePath);
    }

    // Stop ends the turn through the protocol: no signal error anywhere
    await api("POST", `/api/bots/${created.id}/interrupt`);
    await waitFor(async () => (await getBot(created.id)).busy === false, "the steered codex turn to settle");
    const bot = await getBot(created.id);
    expect(JSON.stringify(bot.messages)).not.toContain("SIGTERM");
    expect(stderr).not.toContain("signal SIGTERM");
  }, 40_000);

  it("records an uncertain steer once and never restores it for replay", async () => {
    const created = (await api("POST", "/api/bots")).body.bot;
    const instance = (await api("GET", "/api/instances")).body.instances.find((i: any) => i.instanceId === "codexUnknown");
    await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId: "codexUnknown", model: instance.models.default } });
    await api("POST", `/api/bots/${created.id}/messages`, { text: "start held turn" });
    await waitFor(async () => (await getBot(created.id)).messages.some((m: any) => m.card), "held unknown-delivery turn");
    const outcome = await enqueueThenSteer(`/api/bots/${created.id}/messages`, { text: "uncertain input", threadId: created.threadId });
    expect(outcome.body).toMatchObject({ outcomeUnknown: true, steered: false });
    expect(outcome.body.message.steerDelivery).toBe("outcome_unknown");
    const route = `/api/bots/${created.id}/queue/${outcome.body.message.queueId}/steer`;
    const bot = await getBot(created.id);
    expect(bot.messages.filter((m: any) => m.text === "uncertain input")).toHaveLength(1);
    expect(bot.messages.find((m: any) => m.text === "uncertain input").steerDelivery).toBe("outcome_unknown");
    expect(bot.messages.some((m: any) => m.tool?.name.includes("delivery outcome unknown"))).toBe(true);
    expect((await api("POST", route, { threadId: created.threadId })).body).not.toMatchObject({ steered: true });
    const native = readFileSync(join(home, ".openmausbot", "native", `${created.threadId}.ndjson`), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(native.filter(row => row.dir === "out" && row.msg?.method === "turn/steer")).toHaveLength(1);
    await api("POST", `/api/bots/${created.id}/interrupt`);
  // Explicit Steer waits for the driver's 10-second lost-ack deadline;
  // allow fixture setup and cleanup the same budget as the other Codex cases.
  }, 40_000);

  it("records an uncertain room steer once without claiming delivery or replaying it", async () => {
    const created=(await api("POST","/api/bots")).body.bot;
    const instance=(await api("GET","/api/instances")).body.instances.find((i:any)=>i.instanceId==="codexUnknown");
    await api("PATCH",`/api/bots/${created.id}`,{modelSelection:{instanceId:"codexUnknown",model:instance.models.default}});
    const room=(await api("POST","/api/groups",{name:"Uncertain room steer",memberIds:[created.id],setup:{bulletin:"",defaultResponder:{kind:"member",botId:created.id}}})).body.group;
    const getGroup=async()=>(await api("GET","/api/bots?messages=100")).body.groups.find((g:any)=>g.id===room.id);
    await api("POST",`/api/groups/${room.id}/messages`,{text:"start held room turn"});
    await waitFor(async()=>(await getGroup()).messages.some((m:any)=>m.card),"room held turn");
    const outcome=await enqueueThenSteer(`/api/groups/${room.id}/messages`,{text:"uncertain room input"});
    expect(outcome.body).toMatchObject({steered:false,outcomeUnknown:true});
    const route=`/api/groups/${room.id}/queue/${outcome.body.message.queueId}/steer`;
    const messages=(await getGroup()).messages;
    expect(messages.filter((m:any)=>m.text==="uncertain room input")).toHaveLength(1);
    expect(messages.find((m:any)=>m.text==="uncertain room input").steered).toBe(false);
    expect(messages.some((m:any)=>m.tool?.name.includes("delivery outcome unknown"))).toBe(true);
    expect((await api("POST",route,{threadId:room.threadId})).status).toBe(404);
    await api("POST",`/api/groups/${room.id}/interrupt`,{});
  },40_000);

  it("the queue steer endpoint pulls a codex queue into the running turn once the engine can steer", async () => {
    const created = (await api("POST", "/api/bots")).body.bot;
    const instances = (await api("GET", "/api/instances")).body.instances;
    const model = instances.find((i: any) => i.instanceId === "codexRace").models.default;
    await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId: "codexRace", model } });

    expect((await api("POST", `/api/bots/${created.id}/messages`, { text: "first gated turn" })).status).toBe(202);
    await waitFor(async () => (await getBot(created.id)).busy === true, "the gated turn to start");
    await waitFor(
      async () => (await getBot(created.id)).messages.some((m: any) => m.card),
      "the gated question card",
    );

    // Default POST only queues; the gate refuses an explicit live steer.
    const queued = await api("POST", `/api/bots/${created.id}/messages`, { text: "steer these queued words" });
    expect(queued.body).toMatchObject({ ok: true, queued: true });
    expect((await getBot(created.id)).messages.some((m: any) => m.text === "steer these queued words")).toBe(false);
    const refused = await api("POST", `/api/bots/${created.id}/queue/${queued.body.queueId}/steer`, { threadId: created.threadId });
    expect(refused.body).toMatchObject({ ok: true, queued: true });
    expect((await getBot(created.id)).messages.some((m: any) => m.text === "steer these queued words")).toBe(false);

    rmSync(codexSteerGate, { force: true });
    const steered = await api("POST", `/api/bots/${created.id}/queue/${queued.body.queueId}/steer`, {
      threadId: created.threadId,
    });
    expect(steered.status).toBe(200);
    expect(steered.body.steered).toBe(true);
    expect(steered.body.queueIds).toEqual([queued.body.queueId]);
    const folded = (await getBot(created.id)).messages.find((m: any) => m.text === "steer these queued words");
    expect(folded.steered).toBe(true);

    await api("POST", `/api/bots/${created.id}/interrupt`);
    await waitFor(async () => (await getBot(created.id)).busy === false, "the queue-steered turn to settle");
    expect(stderr).not.toContain("signal SIGTERM");
  }, 40_000);

  it("a refused image steer queues one item, folds a whitespace-collapsed re-send into it, and delivers the image exactly once", async () => {
    writeFileSync(codexSteerGate, "refuse live steers for the refused-image test");
    const created = (await api("POST", "/api/bots")).body.bot;
    const instances = (await api("GET", "/api/instances")).body.instances;
    const model = instances.find((i: any) => i.instanceId === "codexRace").models.default;
    await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId: "codexRace", model } });
    expect((await api("POST", `/api/bots/${created.id}/messages`, { text: "first gated turn" })).status).toBe(202);
    await waitFor(async () => (await getBot(created.id)).messages.some((m: any) => m.card), "the gated question card");

    const attachments = join(home, ".openmausbot", "attachments");
    mkdirSync(attachments, { recursive: true });
    const imagePath = join(attachments, "123e4567-e89b-42d3-a456-426614174099.png");
    writeFileSync(imagePath, "refused pixels");
    const tag = `<attached-image path="${imagePath}" name="image.png" />`;
    const imageText = `balance tu 550 lagi?\n\n${tag}`;
    const queued = await api("POST", `/api/bots/${created.id}/messages`, { text: imageText, sendId: "9a74c727-5bda-4940-b41f-17e32b9e8695" });
    expect(queued.body).toMatchObject({ ok: true, queued: true });
    const refused = await api("POST", `/api/bots/${created.id}/queue/${queued.body.queueId}/steer`, { threadId: created.threadId });
    expect(refused.body).toMatchObject({ ok: true, queued: true });
    // Live rows 21/22: the same send again with its blank lines collapsed joins the one item.
    const again = await api("POST", `/api/bots/${created.id}/messages`, { text: `balance tu 550 lagi? ${tag}`, sendId: "d7f1469c-2f09-48ce-ae9f-c576dee0dead" });
    expect(again.body).toMatchObject({ ok: true, queued: true, queueId: queued.body.queueId });
    expect((await getBot(created.id)).messages.some((m: any) => m.text?.includes(tag))).toBe(false);

    // The duplicate never re-tried the refused steer: one native steer attempt, one file fallback.
    const native = () => readFileSync(join(home, ".openmausbot", "native", `${created.threadId}.ndjson`), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line)).filter((row) => row.dir === "out");
    expect(native().filter((row) => row.msg?.method === "turn/steer")).toHaveLength(2);
    expect((await getBot(created.id)).messages.filter((m: any) => m.tool?.name?.startsWith("image not delivered"))).toHaveLength(1);
    rmSync(codexSteerGate, { force: true });
    // Stop drains the one waiting item into one next turn. (The fake codex
    // cannot resume its thread after Stop, so that turn ends at resume; what
    // this proves is the server side: one dispatch, one row, nothing left.)
    await api("POST", `/api/bots/${created.id}/interrupt`);
    await waitFor(async () => (await getBot(created.id)).messages.some((m: any) => m.role === "user" && m.text === imageText), "the queued image to drain");
    await waitFor(async () => (await getBot(created.id)).busy === false, "the drained turn to settle");
    expect((await getBot(created.id)).messages.filter((m: any) => m.role === "user" && m.text?.includes(tag))).toHaveLength(1);
    expect(native().filter((row) => row.msg?.method === "thread/resume")).toHaveLength(1);
    expect(native().filter((row) => row.msg?.method === "turn/steer")).toHaveLength(2);
    expect((await api("DELETE", `/api/bots/${created.id}/queue/${queued.body.queueId}`, { threadId: created.threadId })).status).toBe(404);

    // After delivery, a client retry under yet another sendId returns the
    // delivered row and dispatches nothing; a fresh upload is a real repeat.
    const delivered = (await getBot(created.id)).messages.find((m: any) => m.role === "user" && m.text === imageText);
    const retry = await api("POST", `/api/bots/${created.id}/messages`, { text: `balance tu 550 lagi?\n${tag}`, sendId: "0c3a7c1e-4c55-4d7e-9f2a-retryafter001" });
    expect(retry.body).toMatchObject({ ok: true, message: { id: delivered.id } });
    expect(retry.body.queued).toBeUndefined();
    expect((await getBot(created.id)).messages.filter((m: any) => m.role === "user" && m.text?.includes(tag))).toHaveLength(1);
    expect(native().filter((row) => row.msg?.method === "thread/resume")).toHaveLength(1);
    const freshPath = join(attachments, "123e4567-e89b-42d3-a456-426614174098.png");
    writeFileSync(freshPath, "same pixels, picked again");
    const repeat = await api("POST", `/api/bots/${created.id}/messages`, { text: `balance tu 550 lagi?\n\n<attached-image path="${freshPath}" name="image.png" />`, sendId: "0c3a7c1e-4c55-4d7e-9f2a-repeatsend01" });
    expect(repeat.body.message?.id ?? repeat.body.queueId).toBeTruthy();
    expect(repeat.body.message?.id).not.toBe(delivered.id);
  }, 40_000);

  it.skipIf(!acpAvailable)("an engine without live steering keeps its queue through the steer endpoint, then drains after Stop", async () => {
    const created = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId: "acp", model: "fake-model" } });
    expect((await api("POST", `/api/bots/${created.id}/messages`, { text: "first" })).status).toBe(202);
    await waitFor(async () => (await getBot(created.id)).busy === true, "the hung turn to start");
    const queued = await api("POST", `/api/bots/${created.id}/messages`, { text: "second" });
    expect(queued.body.queued).toBe(true);

    // the endpoint never interrupts on an incapable engine: the queue waits
    const still = await api("POST", `/api/bots/${created.id}/queue/${queued.body.queueId}/steer`, {
      threadId: created.threadId,
    });
    expect(still.status).toBe(200);
    expect(still.body).toMatchObject({ ok: true, queued: true });
    expect((await getBot(created.id)).busy).toBe(true);
    expect((await getBot(created.id)).messages.some((m: any) => m.text === "second")).toBe(false);

    await api("POST", `/api/bots/${created.id}/interrupt`);
    await waitFor(
      async () => (await getBot(created.id)).messages.some((m: any) => m.text === "second"),
      "the preserved queue to drain",
    );
    await api("POST", `/api/bots/${created.id}/interrupt`);
    await waitFor(async () => (await getBot(created.id)).busy === false, "the drained turn to settle");
  }, 40_000);

  it("a room steer folds the queued head into the running codex turn, and room Stop reports no SIGTERM", async () => {
    const created = (await api("POST", "/api/bots")).body.bot;
    const instances = (await api("GET", "/api/instances")).body.instances;
    const model = instances.find((i: any) => i.instanceId === "codex").models.default;
    await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId: "codex", model } });
    const room = (await api("POST", "/api/groups", {
      name: "Steer room",
      memberIds: [created.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: created.id } },
    })).body.group;
    const getGroup = async () =>
      (await api("GET", "/api/bots?messages=30")).body.groups.find((g: any) => g.id === room.id);

    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "first room turn" })).status).toBe(202);
    await waitFor(async () => (await getGroup())?.busyBotId === created.id, "the room turn to start");
    await waitFor(async () => (await getGroup())?.messages.some((m: any) => m.card), "the room question card");

    // Explicit Steer folds the queued head into the busy addressed member's turn
    const steered = await enqueueThenSteer(`/api/groups/${room.id}/messages`, { text: "steer these room words" });
    expect(steered.status).toBe(200);
    expect(steered.body).toMatchObject({ ok: true, steered: true });
    const folded = (await getGroup())?.messages.find((m: any) => m.text === "steer these room words");
    expect(folded?.steered).toBe(true);

    // the fold reached the app-server as mid-turn input for the SAME turn
    const aliases = JSON.parse(readFileSync(join(home,".openmausbot","room-runtime-aliases.json"),"utf8"));
    const runtimeId = aliases.find(([, owner]: [string, {threadId:string;botId:string}]) => owner.threadId === room.threadId && owner.botId === created.id)?.[0];
    expect(runtimeId).toBeDefined();
    const nativeRows = readFileSync(join(home, ".openmausbot", "native", `${runtimeId}.ndjson`), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line));
    const steerRow = nativeRows.find((row) => row.dir === "out" && row.msg?.method === "turn/steer")?.msg;
    expect(steerRow?.params).toMatchObject({ input: [{ type: "text", text: "steer these room words" }] });

    await api("POST", `/api/groups/${room.id}/interrupt`, {});
    await waitFor(async () => (await getGroup())?.working === false, "the steered room turn to settle");
    expect(JSON.stringify((await getGroup())?.messages)).not.toContain("SIGTERM");
    expect(stderr).not.toContain("signal SIGTERM");
  }, 40_000);

  it.skipIf(!acpAvailable)("a room whose engine cannot steer keeps its queue until room-wide Stop cancels it", async () => {
    const created = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId: "acp", model: "fake-model" } });
    const room = (await api("POST", "/api/groups", {
      name: "Queue room",
      memberIds: [created.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: created.id } },
    })).body.group;
    const getGroup = async () =>
      (await api("GET", "/api/bots?messages=30")).body.groups.find((g: any) => g.id === room.id);

    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "first" })).status).toBe(202);
    await waitFor(async () => (await getGroup())?.busyBotId === created.id, "the hung room turn to start");
    const queued = await api("POST", `/api/groups/${room.id}/messages`, { text: "second" });
    expect(queued.status).toBe(202);
    expect(queued.body).toMatchObject({ ok: true, queued: true });

    // the room steer endpoint never interrupts an incapable engine: the
    // queue waits for the room's own one-at-a-time drain
    const still = await api("POST", `/api/groups/${room.id}/queue/${queued.body.queueId}/steer`, {
      threadId: room.threadId,
    });
    expect(still.status).toBe(200);
    expect(still.body).toMatchObject({ ok: true, queued: true });
    expect((await getGroup())?.working).toBe(true);
    expect((await getGroup())?.messages.some((m: any) => m.text === "second")).toBe(false);

    await api("POST", `/api/groups/${room.id}/interrupt`, {});
    await waitFor(async () => (await getGroup())?.working === false, "the stopped room turn to settle");
    expect((await getGroup())?.messages.some((m:any)=>m.text === "second")).toBe(false);
    expect((await api("DELETE", `/api/groups/${room.id}/queue/${queued.body.queueId}`)).status).toBe(404);

  }, 40_000);
});
// branding compatibility (electron/branding-compat.json): data-home: existing desktop and companion homes, backups and lease recovery must open the same data; environment-aliases: legacy launchd/systemd and provider subprocess environment labels stay accepted; the central resolver always prefers the new spelling
