// Explicit queued-send steer refusal, multi-busy room targeting, and Stop while a steer is
// in flight. Real server, fake codex app-server. Started as the QA repro for
// d02f037f: a refusal racing the end of the turn was recorded "outcome
// unknown" and lost; a stopped in-flight steer was replayed to the next turn;
// the accept-first room order posted no waiting note for the refusing member.
//
// The fake is copied into the temp HOME and patched there (the repo copy is
// untouched) with two test-only knobs:
//   QA_RESUME_OK=1           thread/resume succeeds in every mode, so a drained
//                            follow-up turn really reaches turn/start
//   QA_REFUSE_IMAGE_STEER=1  refuse only turn/steer calls carrying localImage,
//                            so the image-as-files fallback can be observed
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CODEX = join(SERVER_DIR, "testing", "fake-codex-app-server.ts");
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const posixOnly = describe.skipIf(process.platform === "win32");
const REFUSE = JSON.stringify({ code: -32000, message: "active turn is not steerable" });

posixOnly("steer refusal and stop mid-steer", () => {
  let child: ChildProcess;
  let home: string;
  let stderr = "";
  let attachments: string;

  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed: any = text;
    try { parsed = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, body: parsed };
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
  const getGroup = async (id: string) => (await api("GET", "/api/bots?messages=200")).body.groups.find((g: any) => g.id === id);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (predicate: () => Promise<boolean>, what: string, ms = 20_000) => {
    const deadline = Date.now() + ms;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}. stderr: ${stderr.slice(-2000)}`);
      await sleep(100);
    }
  };
  const createBot = async (instanceId: string, name?: string) => {
    const instance = (await api("GET", "/api/instances")).body.instances.find((i: any) => i.instanceId === instanceId);
    const bot = (await api("POST", "/api/bots", name ? { name } : undefined)).body.bot;
    await api("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId, model: instance.models.default } });
    return bot;
  };
  const readNative = (runtimeId: string) => {
    try {
      return readFileSync(join(home, ".openmausbot", "native", `${runtimeId}.ndjson`), "utf8")
        .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((row) => row.dir === "out");
    } catch { return []; }
  };
  const roomRuntimeIds = (roomThreadId: string, botId: string) => {
    try {
      const aliases = JSON.parse(readFileSync(join(home, ".openmausbot", "room-runtime-aliases.json"), "utf8"));
      return aliases.filter(([, owner]: [string, { threadId: string; botId: string }]) => owner.threadId === roomThreadId && owner.botId === botId).map(([id]: [string]) => id);
    } catch { return []; }
  };
  const roomNative = (roomThreadId: string, botId: string) => roomRuntimeIds(roomThreadId, botId).flatMap(readNative);
  const calls = (rows: any[], method: string, marker: string) => rows.filter((row) => row.msg?.method === method && JSON.stringify(row.msg).includes(marker));
  const hasImage = (row: any) => (row.msg?.params?.input ?? []).some((item: any) => item?.type === "localImage");
  const openCards = (messages: any[], botId?: string) =>
    messages.filter((m: any) => m.card && !m.card.answered && !m.card.dismissed && (!botId || !m.from?.botId || m.from.botId === botId));
  const image = (name: string) => {
    const path = join(attachments, name);
    writeFileSync(path, `pixels ${name}`);
    return `<attached-image path="${path}" name="${name}" />`;
  };

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "omb-steer-refusal-"));
    mkdirSync(join(home, ".openmausbot"), { recursive: true });
    attachments = join(home, ".openmausbot", "attachments");
    mkdirSync(attachments, { recursive: true });
    // Patched copy of the fake codex app server (see header).
    const fakeDir = join(home, "fake");
    mkdirSync(fakeDir);
    writeFileSync(join(fakeDir, "package.json"), JSON.stringify({ type: "module" }));
    let source = readFileSync(FAKE_CODEX, "utf8");
    const resumeNeedle = `} else if (mode === "resume" || mode === "helper-events"`;
    const steerNeedle = `        if (process.env.FAKE_CODEX_STEER_ERROR) {`;
    expect(source.includes(resumeNeedle) && source.includes(steerNeedle)).toBe(true);
    source = source.replace(resumeNeedle, `} else if (process.env.QA_RESUME_OK === "1" || mode === "resume" || mode === "helper-events"`);
    source = source.replace(steerNeedle, `        if (process.env.QA_REFUSE_IMAGE_STEER === "1" && (msg.params?.input ?? []).some((item: any) => item?.type === "localImage")) {
          refused("this turn cannot take images");
          break;
        }
${steerNeedle}`);
    const fake = join(fakeDir, "fake-codex-app-server.ts");
    writeFileSync(fake, source);
    chmodSync(fake, 0o755);
    const codex = (environment: Record<string, string>) => ({
      driver: "codex",
      environment: { QA_RESUME_OK: "1", ...environment },
      config: { cli: fake },
    });
    writeFileSync(
      join(home, ".openmausbot", "config.json"),
      JSON.stringify({
        instances: {
          qaAccept: codex({ FAKE_CODEX_MODE: "question" }),
          qaRefuse: codex({ FAKE_CODEX_MODE: "question", FAKE_CODEX_STEER_ERROR: REFUSE }),
          qaImgRefuse: codex({ FAKE_CODEX_MODE: "question", QA_REFUSE_IMAGE_STEER: "1" }),
          qaHang: codex({ FAKE_CODEX_MODE: "question", FAKE_CODEX_STEER_HANG: "1", FAKE_CODEX_STEER_TIMEOUT_MS: "6000" }),
          qaQuick: codex({ FAKE_CODEX_MODE: "happy" }),
        },
      }),
    );
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: { ...(process.env.PATH ? { PATH: process.env.PATH } : {}), HOME: home, USERPROFILE: home, OMB_PORT: String(PORT) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (c) => (stderr += c));
    const deadline = Date.now() + 20_000;
    for (;;) {
      try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* not up yet */ }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
      await sleep(150);
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

  // (c) 1:1, every steer refused (native image AND file fallback).
  it("c: a refused explicit queued image steer is noted, stays one queued item, and reaches the next turn exactly once", async () => {
    const bot = await createBot("qaRefuse");
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "start c" })).status).toBe(202);
    await waitFor(async () => openCards((await getBot(bot.id)).messages).length > 0, "c: held turn");
    const marker = "MARKC-image";
    const text = `${marker} what is this?\n\n${image("123e4567-e89b-42d3-a456-426614174c01.png")}`;
    const sent = await enqueueThenSteer(`/api/bots/${bot.id}/messages`, { text, sendId: "qa-d02-c-send-0001" });
    console.log("[c] send receipt", sent.status, JSON.stringify(sent.body));
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ ok: true, queued: true });
    let messages = (await getBot(bot.id)).messages;
    const notes = messages.filter((m: any) => /not delivered/.test(m.tool?.name ?? "")).map((m: any) => m.tool.name);
    console.log("[c] notes after refusal", JSON.stringify(notes));
    expect(notes.length).toBe(1);
    expect(messages.filter((m: any) => m.role === "user" && m.text?.includes(marker))).toHaveLength(0);
    const steersNow = calls(readNative(bot.threadId), "turn/steer", marker);
    console.log("[c] steer attempts at send", steersNow.length, steersNow.map(hasImage));

    // End the current turn naturally: answer the question card.
    const card = openCards(messages)[0];
    const answered = await api("POST", `/api/bots/${bot.id}/respond`, { threadId: bot.threadId, requestId: card.card.requestId, behavior: "deny" });
    console.log("[c] answer", answered.status, JSON.stringify(answered.body));
    try {
      await waitFor(async () => calls(readNative(bot.threadId), "turn/start", marker).length > 0, "c: the queued image to start the next turn");
    } catch (error) {
      const b = await getBot(bot.id);
      console.log("[c] STUCK busy", b.busy, "steer rows hasImage", JSON.stringify(calls(readNative(bot.threadId), "turn/steer", marker).map(hasImage)), "rows around steer", JSON.stringify(readNative(bot.threadId).slice(-3).map((row) => JSON.stringify(row.msg).slice(0, 200))), "native methods", JSON.stringify(readNative(bot.threadId).map((row) => row.msg?.method)),
        "tail", JSON.stringify(b.messages.slice(-8).map((m: any) => ({ role: m.role, kind: m.kind, text: m.text?.slice(0, 80), tool: m.tool?.name, card: Boolean(m.card), answered: m.card?.answered }))),
        "queue delete status (probe only, not executed)", sent.body.queueId);
      console.log("[c] stderr tail", stderr.slice(-3000));
      throw error;
    }
    await waitFor(async () => openCards((await getBot(bot.id)).messages).length > 0, "c: the follow-up turn to park");
    await sleep(1500);
    messages = (await getBot(bot.id)).messages;
    const starts = calls(readNative(bot.threadId), "turn/start", marker);
    const steersAll = calls(readNative(bot.threadId), "turn/steer", marker);
    const userRows = messages.filter((m: any) => m.role === "user" && m.text?.includes(marker));
    console.log("[c] after turn end: turn/start with marker", starts.length, "with image", starts.map(hasImage), "steer attempts total", steersAll.length, "user rows", userRows.length,
      "notes", JSON.stringify(messages.filter((m: any) => /not delivered|delivered/.test(m.tool?.name ?? "")).map((m: any) => m.tool.name)));
    expect(userRows).toHaveLength(1);
    expect(starts).toHaveLength(1);
    expect(hasImage(starts[0])).toBe(true);
    expect((await api("DELETE", `/api/bots/${bot.id}/queue/${sent.body.queueId}`, { threadId: bot.threadId })).status).toBe(404);
    await api("POST", `/api/bots/${bot.id}/interrupt`);
    await waitFor(async () => (await getBot(bot.id)).busy === false, "c: settle");
    await sleep(800);
    expect(calls(readNative(bot.threadId), "turn/start", marker)).toHaveLength(1);
  }, 60_000);

  // (c, text variant) same as (c) without an image, to see whether the end-of-turn race is image specific.
  it("c-text: a refused explicit queued text steer reaches the next turn exactly once after the turn ends", async () => {
    const bot = await createBot("qaRefuse");
    await api("POST", `/api/bots/${bot.id}/messages`, { text: "start ct" });
    await waitFor(async () => openCards((await getBot(bot.id)).messages).length > 0, "ct: held turn");
    const marker = "MARKCT-text";
    const sent = await enqueueThenSteer(`/api/bots/${bot.id}/messages`, { text: `${marker} plain words`, sendId: "qa-d02-ct-send-0001" });
    console.log("[ct] send receipt", sent.status, JSON.stringify(sent.body));
    expect(sent.body).toMatchObject({ ok: true, queued: true });
    let messages = (await getBot(bot.id)).messages;
    console.log("[ct] notes", JSON.stringify(messages.filter((m: any) => /deliver/.test(m.tool?.name ?? "")).map((m: any) => m.tool.name)));
    const card = openCards(messages)[0];
    await api("POST", `/api/bots/${bot.id}/respond`, { threadId: bot.threadId, requestId: card.card.requestId, behavior: "deny" });
    await waitFor(async () => (await getBot(bot.id)).busy === false || calls(readNative(bot.threadId), "turn/start", marker).length > 0, "ct: settle or drain");
    await sleep(3000);
    messages = (await getBot(bot.id)).messages;
    const starts = calls(readNative(bot.threadId), "turn/start", marker);
    const rows = messages.filter((m: any) => m.role === "user" && m.text?.includes(marker));
    console.log("[ct] turn/start with marker", starts.length, "steer attempts", calls(readNative(bot.threadId), "turn/steer", marker).length, "user rows", JSON.stringify(rows.map((m: any) => ({ steered: m.steered }))),
      "notes", JSON.stringify(messages.filter((m: any) => /deliver/.test(m.tool?.name ?? "")).map((m: any) => m.tool.name)));
    await api("POST", `/api/bots/${bot.id}/interrupt`);
    expect(rows).toHaveLength(1);
    expect(starts).toHaveLength(1);
  }, 60_000);

  // (c, fallback) native image refused, the same words with file paths accepted.
  it("c-fallback: a refused explicit native image steer is retried as text with the file path, recorded once, never replayed", async () => {
    const bot = await createBot("qaImgRefuse");
    await api("POST", `/api/bots/${bot.id}/messages`, { text: "start c2" });
    await waitFor(async () => openCards((await getBot(bot.id)).messages).length > 0, "c2: held turn");
    const marker = "MARKC2-image";
    const file = "123e4567-e89b-42d3-a456-426614174c02.png";
    const sent = await enqueueThenSteer(`/api/bots/${bot.id}/messages`, { text: `${marker} see\n\n${image(file)}`, sendId: "qa-d02-c2-send-0001" });
    console.log("[c2] send receipt", sent.status, JSON.stringify(sent.body));
    const steers = calls(readNative(bot.threadId), "turn/steer", marker);
    console.log("[c2] steers", steers.map((row) => JSON.stringify(row.msg.params.input)));
    const messages = (await getBot(bot.id)).messages;
    const notes = messages.filter((m: any) => m.kind === "activity" && /image|deliver/.test(m.tool?.name ?? "")).map((m: any) => m.tool.name);
    console.log("[c2] notes", JSON.stringify(notes));
    expect(sent.body).toMatchObject({ ok: true, steered: true });
    expect(steers).toHaveLength(2);
    expect(hasImage(steers[0])).toBe(true);
    expect(hasImage(steers[1])).toBe(false);
    expect(JSON.stringify(steers[1].msg.params.input)).toContain(file);
    expect(notes).toContain("image sent to the running turn as a file it can open");
    expect(messages.filter((m: any) => m.role === "user" && m.text?.includes(marker))).toHaveLength(1);
    const card = openCards(messages)[0];
    await api("POST", `/api/bots/${bot.id}/respond`, { threadId: bot.threadId, requestId: card.card.requestId, behavior: "deny" });
    await waitFor(async () => (await getBot(bot.id)).busy === false, "c2: settle");
    await sleep(1500);
    expect(calls(readNative(bot.threadId), "turn/start", marker)).toHaveLength(0);
    expect(calls(readNative(bot.threadId), "turn/steer", marker)).toHaveLength(2);
  }, 60_000);

  // Explicit Steer cannot ambiguously select among several busy addressees.
  // The refused and accepting single-target cases above pin provider behavior;
  // this pins that the mixed queued send stays intact and never starts an idle
  // member before the room's current work settles, regardless of member order.
  for (const order of ["refuser-first", "accepter-first"] as const) {
    it(`d (${order}): ambiguous explicit room steer preserves the mixed queued image and delivers once after settle`, async () => {
      const tag = order === "refuser-first" ? "R" : "A";
      const acc = await createBot("qaAccept", `Acc${tag}`);
      const ref = await createBot("qaRefuse", `Ref${tag}`);
      const quick = await createBot("qaQuick", `Quick${tag}`);
      const members = order === "refuser-first" ? [ref.id, acc.id, quick.id] : [acc.id, ref.id, quick.id];
      const room = (await api("POST", "/api/groups", { name: `QA explicit mixed ${tag}`, memberIds: members, setup: { bulletin: "", defaultResponder: { kind: "mentions" } } })).body.group;
      await api("POST", `/api/groups/${room.id}/messages`, { text: `@Acc${tag} @Ref${tag} start` });
      await waitFor(async () => {
        const g = await getGroup(room.id);
        return [acc.id, ref.id].every(id => openCards(g.messages.filter((m: any) => m.from?.botId === id)).length > 0);
      }, "d: two members parked");
      const marker = `MARKD${tag}-image`;
      const text = `@Acc${tag} @Ref${tag} @Quick${tag} ${marker}\n\n${image(`123e4567-e89b-42d3-a456-4266141740d${tag === "R" ? "1" : "2"}.png`)}`;
      const queued = await api("POST", `/api/groups/${room.id}/messages`, { text, sendId: `qa-d02-d-send-${tag}-0001` });
      expect(queued.status).toBe(202);
      expect(queued.body).toMatchObject({ ok: true, queued: true });
      const route = `/api/groups/${room.id}/queue/${queued.body.queueId}/steer`;
      expect((await api("POST", route, { threadId: room.threadId })).status).toBe(409);
      expect((await api("POST", route, { threadId: room.threadId, botId: acc.id })).status).toBe(409);
      for (const member of [acc, ref, quick]) {
        expect(calls(roomNative(room.threadId, member.id), "turn/steer", marker)).toHaveLength(0);
        expect(calls(roomNative(room.threadId, member.id), "turn/start", marker)).toHaveLength(0);
      }
      const held = await getGroup(room.id);
      expect(held.messages.filter((m: any) => m.role === "user" && m.text?.includes(marker))).toHaveLength(0);
      for (const member of [acc, ref]) {
        const card = openCards(held.messages.filter((m: any) => m.from?.botId === member.id))[0];
        await api("POST", `/api/threads/${room.threadId}/respond`, { requestId: card.card.requestId, behavior: "deny" });
      }
      await waitFor(async () => [acc, ref, quick].every(member => calls(roomNative(room.threadId, member.id), "turn/start", marker).length === 1), "d: mixed queued image drains once");
      const messages = (await getGroup(room.id)).messages;
      expect(messages.filter((m: any) => m.role === "user" && m.text?.includes(marker))).toHaveLength(1);
      for (const member of [acc, ref, quick]) {
        const starts = calls(roomNative(room.threadId, member.id), "turn/start", marker);
        expect(starts).toHaveLength(1);
        expect(hasImage(starts[0])).toBe(true);
      }
      expect((await api("DELETE", `/api/groups/${room.id}/queue/${queued.body.queueId}`)).status).toBe(404);
      await api("POST", `/api/groups/${room.id}/interrupt`, {});
      await waitFor(async () => (await getGroup(room.id)).working === false, "d: settle");
      await sleep(1000);
      for (const member of [acc, ref, quick]) expect(calls(roomNative(room.threadId, member.id), "turn/start", marker)).toHaveLength(1);
    }, 90_000);
  }

  // (e) Stop while a 1:1 steer is in flight.
  it("e: Stop during a pending explicit steer records unknown at most once, never replays, and the next send works", async () => {
    const bot = await createBot("qaHang");
    await api("POST", `/api/bots/${bot.id}/messages`, { text: "start e" });
    await waitFor(async () => openCards((await getBot(bot.id)).messages).length > 0, "e: held turn");
    const marker = "MARKE-pending";
    const pending = enqueueThenSteer(`/api/bots/${bot.id}/messages`, { text: `${marker} words`, sendId: "qa-d02-e-send-0001" });
    await waitFor(async () => calls(readNative(bot.threadId), "turn/steer", marker).length > 0, "e: steer in flight", 5_000);
    const t0 = Date.now();
    const stop = await api("POST", `/api/bots/${bot.id}/interrupt`);
    const sent = await pending;
    console.log("[e] stop", stop.status, JSON.stringify(stop.body), "send", sent.status, JSON.stringify(sent.body), "send resolved after stop in ms", Date.now() - t0);
    expect(stop.status).toBeLessThan(500);
    expect(sent.status).toBeLessThan(500);
    await waitFor(async () => (await getBot(bot.id)).busy === false, "e: settle");
    await sleep(2000);
    let messages = (await getBot(bot.id)).messages;
    const rows = messages.filter((m: any) => m.role === "user" && m.text?.includes(marker));
    const unknown = messages.filter((m: any) => /outcome unknown/.test(m.tool?.name ?? ""));
    console.log("[e] user rows", rows.length, JSON.stringify(rows.map((m: any) => ({ steered: m.steered }))), "unknown notes", unknown.length, "turn/start with marker", calls(readNative(bot.threadId), "turn/start", marker).length);
    expect(rows.length).toBeLessThanOrEqual(1);
    expect(unknown.length).toBeLessThanOrEqual(1);
    if (rows.length === 1) expect(rows[0].steered).not.toBe(true);
    expect(calls(readNative(bot.threadId), "turn/start", marker)).toHaveLength(0);
    if (sent.body?.queueId) expect((await api("DELETE", `/api/bots/${bot.id}/queue/${sent.body.queueId}`, { threadId: bot.threadId })).status).toBe(404);
    if (sent.body?.message?.queueId) expect((await api("DELETE", `/api/bots/${bot.id}/queue/${sent.body.message.queueId}`, { threadId: bot.threadId })).status).toBe(404);
    // a fresh send afterwards starts a new turn
    const fresh = await api("POST", `/api/bots/${bot.id}/messages`, { text: "AFTER-E fresh" });
    console.log("[e] fresh", fresh.status, JSON.stringify(fresh.body));
    expect(fresh.status).toBe(202);
    expect(fresh.body.queued).toBeUndefined();
    await waitFor(async () => calls(readNative(bot.threadId), "turn/start", "AFTER-E fresh").length > 0, "e: fresh turn starts");
    const freshStart = calls(readNative(bot.threadId), "turn/start", "AFTER-E fresh")[0];
    console.log("[e] fresh turn/start carries the stopped words?", JSON.stringify(freshStart.msg).includes(marker));
    expect(JSON.stringify(freshStart.msg)).not.toContain(marker);
    await api("POST", `/api/bots/${bot.id}/interrupt`);
    await waitFor(async () => (await getBot(bot.id)).busy === false, "e: final settle");
    messages = (await getBot(bot.id)).messages;
    expect(messages.filter((m: any) => m.role === "user" && m.text?.includes(marker)).length).toBeLessThanOrEqual(1);
    expect((await fetch(`${BASE}/api/health`)).ok).toBe(true);
  }, 60_000);

  // (e, room) Stop while a mixed multi-busy room steer is in flight.
  it("e-room: Stop during a pending explicit room steer with other busy members starts no idle addressee and replays nothing", async () => {
    const h1 = await createBot("qaHang", "HangOne");
    const h2 = await createBot("qaHang", "HangTwo");
    const idle = await createBot("qaQuick", "IdleThree");
    const room = (await api("POST", "/api/groups", { name: "QA stop mid steer", memberIds: [h1.id, h2.id, idle.id], setup: { bulletin: "", defaultResponder: { kind: "mentions" } } })).body.group;
    await api("POST", `/api/groups/${room.id}/messages`, { text: "@HangOne @HangTwo start" });
    await waitFor(async () => {
      const g = await getGroup(room.id);
      return [h1.id, h2.id].every((id) => openCards(g.messages.filter((m: any) => m.from?.botId === id)).length > 0);
    }, "e-room: two parked");
    const marker = "MARKER-room";
    const pending = enqueueThenSteer(`/api/groups/${room.id}/messages`, { text: `@HangOne ${marker}`, sendId: "qa-d02-er-send-0001" });
    await waitFor(async () => calls(roomNative(room.threadId, h1.id), "turn/steer", marker).length + calls(roomNative(room.threadId, h2.id), "turn/steer", marker).length > 0, "e-room: steer in flight", 5_000);
    const stop = await api("POST", `/api/groups/${room.id}/interrupt`, {});
    const sent = await pending;
    console.log("[e-room] stop", stop.status, JSON.stringify(stop.body), "send", sent.status, JSON.stringify(sent.body));
    expect(stop.status).toBeLessThan(500);
    expect(sent.status).toBeLessThan(500);
    await waitFor(async () => (await getGroup(room.id)).working === false, "e-room: settle");
    await sleep(2500);
    const g = await getGroup(room.id);
    const counts = Object.fromEntries([["h1", h1], ["h2", h2], ["idle", idle]].map(([k, b]: any) => [k, {
      steer: calls(roomNative(room.threadId, b.id), "turn/steer", marker).length,
      start: calls(roomNative(room.threadId, b.id), "turn/start", marker).length,
    }]));
    const rows = g.messages.filter((m: any) => m.role === "user" && m.text?.includes(marker));
    const unknown = g.messages.filter((m: any) => /outcome unknown/.test(m.tool?.name ?? ""));
    console.log("[e-room] counts", JSON.stringify(counts), "user rows", rows.length, "unknown notes", unknown.map((m: any) => m.tool.name));
    expect(counts.idle.start).toBe(0);
    expect(counts.h1.start + counts.h2.start).toBe(0);
    expect(rows.length).toBeLessThanOrEqual(1);
    if (sent.body?.queueId) expect((await api("DELETE", `/api/groups/${room.id}/queue/${sent.body.queueId}`)).status).toBe(404);
    const fresh = await api("POST", `/api/groups/${room.id}/messages`, { text: "@IdleThree AFTER-ER fresh" });
    expect(fresh.status).toBe(202);
    await waitFor(async () => calls(roomNative(room.threadId, idle.id), "turn/start", "AFTER-ER fresh").length > 0, "e-room: fresh send works");
    // Observation only: the stopped line may appear as room history in the idle member's next turn.
    const later = calls(roomNative(room.threadId, idle.id), "turn/start", "AFTER-ER fresh")[0];
    console.log("[e-room] idle fresh turn/start input", JSON.stringify(later.msg.params.input).slice(0, 1500));
    expect(existsSync(home)).toBe(true);
  }, 60_000);
});
