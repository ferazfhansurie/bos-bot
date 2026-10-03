// 1.3 updater acceptance suite (qa). Written against the shared contract in
// release/v1.3-build/handout-2026-10-03.md, before the backend lands:
//
//   GET  /api/update/status  -> { state, current:{version,sha}, candidate?, busyTurns, lastResult? }
//   POST /api/update/apply   {force?} -> 202 {updateId} | 409 when already running
//   POST /api/update/restart {force?} -> 202
//   runtime stream event      {type:"update.state", state, updateId, detail}
//
// Isolation: every case boots the real harness with HOME in a temp dir and a
// COPIED fake app bundle under that dir. Never /Applications, never ~/.bos-bot,
// never real launchd.
//
// Two groups:
//   "relaunch delivery (runnable now)" — steer/image guarantees across a server
//     relaunch on the same data dir. Runs today against existing code.
//   "updater contract (needs backend)" — skipped until server/update/ exists or
//     index.ts serves /api/update/status. Test seams the backend must honour
//     (env on the harness process; agree/rename with backend bot):
//       OMB_UPDATE_SANDBOX=1           no launchd; detached updater is a child process,
//                                      relaunch = harness exits 0 and the test supervisor
//                                      restarts it (see `supervise`)
//       OMB_UPDATE_APP_PATH            the "live" bundle (a copy)
//       OMB_UPDATE_STAGED_PATH         the staged candidate bundle
//       OMB_UPDATE_JOBS_DIR            where updater/keepalive job plists are looked for
//       OMB_UPDATE_FAULT               kill-mid-swap | health-fail (fault injection)
//
// POSIX-gated like the other CLI e2es (the fakes are shebang scripts).
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CODEX = join(SERVER_DIR, "testing", "fake-codex-app-server.ts");
const posixOnly = !(process.platform === "win32");
const backendPresent = existsSync(join(SERVER_DIR, "update"))
  || readFileSync(join(SERVER_DIR, "index.ts"), "utf8").includes("/api/update/status");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Harness = ReturnType<typeof makeHarness>;

function makeHarness(prefix: string, extraEnv: () => Record<string, string> = () => ({})) {
  const port = 18800 + Math.floor(Math.random() * 10_000);
  const base = `http://127.0.0.1:${port}`;
  const home = mkdtempSync(join(tmpdir(), prefix));
  const data = join(home, ".openmausbot");
  const attachments = join(data, "attachments");
  mkdirSync(attachments, { recursive: true });
  let child: ChildProcess | undefined;
  let stderr = "";
  let boots = 0;

  // Patched fake codex: QA_RESUME_OK lets a relaunched harness resume the
  // provider thread (same patch as steer-refusal-stop.e2e).
  const fakeDir = join(home, "fake");
  mkdirSync(fakeDir);
  writeFileSync(join(fakeDir, "package.json"), JSON.stringify({ type: "module" }));
  let source = readFileSync(FAKE_CODEX, "utf8");
  const resumeNeedle = `} else if (mode === "resume" || mode === "helper-events"`;
  if (!source.includes(resumeNeedle)) throw new Error("fake codex resume needle moved");
  source = source.replace(resumeNeedle, `} else if (process.env.QA_RESUME_OK === "1" || mode === "resume" || mode === "helper-events"`);
  const fake = join(fakeDir, "fake-codex-app-server.ts");
  writeFileSync(fake, source);
  chmodSync(fake, 0o755);
  const codex = (environment: Record<string, string>) => ({ driver: "codex", environment: { QA_RESUME_OK: "1", ...environment }, config: { cli: fake } });
  writeFileSync(join(data, "config.json"), JSON.stringify({
    instances: {
      qaHold: codex({ FAKE_CODEX_MODE: "question", FAKE_CODEX_ASK_HOLD: "1" }),
      qaQuick: codex({ FAKE_CODEX_MODE: "happy" }),
    },
  }));

  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed: any = text;
    try { parsed = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, body: parsed };
  };
  const waitFor = async (predicate: () => Promise<boolean>, what: string, ms = 20_000) => {
    const deadline = Date.now() + ms;
    while (!(await predicate().catch(() => false))) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}. stderr: ${stderr.slice(-2000)}`);
      await sleep(100);
    }
  };
  const healthy = async () => { try { return (await fetch(`${base}/api/health`)).ok; } catch { return false; } };
  const start = async () => {
    boots++;
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: { ...(process.env.PATH ? { PATH: process.env.PATH } : {}), HOME: home, USERPROFILE: home, OMB_PORT: String(port), ...extraEnv() },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (c) => (stderr += c));
    const proc = child;
    const deadline = Date.now() + 20_000;
    while (!(await healthy())) {
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      if (proc.exitCode !== null) throw new Error(`server exited ${proc.exitCode}. stderr:\n${stderr}`);
      await sleep(150);
    }
  };
  const stop = async (signal: NodeJS.Signals = "SIGTERM") => {
    const proc = child;
    if (!proc || proc.exitCode !== null) return;
    proc.kill(signal);
    await new Promise<void>((resolve) => {
      if (proc.exitCode !== null) return resolve();
      proc.on("close", () => resolve());
      setTimeout(() => (proc.kill("SIGKILL"), resolve()), 8_000).unref?.();
    });
  };
  const relaunch = async () => { await stop(); await start(); };
  const dispose = async () => { await stop(); rmSync(home, { recursive: true, force: true }); };

  const getBot = async (id: string) => (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === id);
  const getGroup = async (id: string) => (await api("GET", "/api/bots?messages=200")).body.groups.find((g: any) => g.id === id);
  const createBot = async (instanceId: string, name?: string) => {
    const instance = (await api("GET", "/api/instances")).body.instances.find((i: any) => i.instanceId === instanceId);
    const bot = (await api("POST", "/api/bots", name ? { name } : undefined)).body.bot;
    await api("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId, model: instance.models.default } });
    return bot;
  };
  const readNative = (runtimeId: string) => {
    try {
      return readFileSync(join(data, "native", `${runtimeId}.ndjson`), "utf8")
        .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((row) => row.dir === "out");
    } catch { return []; }
  };
  const roomNative = (roomThreadId: string, botId: string) => {
    try {
      const aliases = JSON.parse(readFileSync(join(data, "room-runtime-aliases.json"), "utf8"));
      return aliases.filter(([, o]: [string, { threadId: string; botId: string }]) => o.threadId === roomThreadId && o.botId === botId)
        .flatMap(([id]: [string]) => readNative(id));
    } catch { return []; }
  };
  const calls = (rows: any[], method: string, marker: string) => rows.filter((row) => row.msg?.method === method && JSON.stringify(row.msg).includes(marker));
  const openCards = (messages: any[]) => messages.filter((m: any) => m.card && !m.card.answered && !m.card.dismissed);
  const image = (name: string) => {
    const path = join(attachments, name);
    writeFileSync(path, `pixels ${name}`);
    return `<attached-image path="${path}" name="${name}" />`;
  };
  // update.state events off the existing runtime stream
  const collectEvents = () => {
    const events: any[] = [];
    const ctl = new AbortController();
    void (async () => {
      try {
        const res = await fetch(`${base}/api/events`, { signal: ctl.signal });
        const reader = res.body!.getReader();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += Buffer.from(value).toString("utf8");
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, i); buf = buf.slice(i + 2);
            for (const line of frame.split("\n")) {
              if (!line.startsWith("data:")) continue;
              try { const e = JSON.parse(line.slice(5)); if (e?.type === "update.state") events.push(e); } catch { /* not json */ }
            }
          }
        }
      } catch { /* aborted or server went down for relaunch */ }
    })();
    return { events, close: () => ctl.abort() };
  };

  return {
    base, home, data, api, waitFor, start, stop, relaunch, dispose, healthy,
    getBot, getGroup, createBot, readNative, roomNative, calls, openCards, image, collectEvents,
    get stderr() { return stderr; }, get boots() { return boots; }, get child() { return child; },
  };
}

// ---------------------------------------------------------------------------
// Runnable now: delivery guarantees across a relaunch on the same data dir.
// ---------------------------------------------------------------------------
describe.skipIf(!posixOnly)("updater acceptance: relaunch delivery (runnable now)", () => {
  let h: Harness;
  beforeAll(async () => { h = makeHarness("omb-upd-now-"); await h.start(); }, 30_000);
  afterAll(async () => { await h?.dispose(); });

  it("image sent into a busy turn before relaunch is delivered once and never replayed after", async () => {
    const bot = await h.createBot("qaHold");
    await h.api("POST", `/api/bots/${bot.id}/messages`, { text: "start image case" });
    await h.waitFor(async () => h.openCards((await h.getBot(bot.id)).messages).length > 0, "held turn");
    const marker = "UPDIMG-once";
    const sent = await h.api("POST", `/api/bots/${bot.id}/messages`, {
      text: `${marker} what is this\n\n${h.image("123e4567-e89b-42d3-a456-426614175a01.png")}`,
      sendId: "qa-upd-image-0001",
    });
    if (sent.status !== 202) console.log("[img] send", sent.status, JSON.stringify(sent.body));
    expect(sent.status).toBe(202);
    expect(sent.body).toMatchObject({ ok: true, steered: true });
    const delivered = () => h.calls(h.readNative(bot.threadId), "turn/steer", marker).length + h.calls(h.readNative(bot.threadId), "turn/start", marker).length;
    expect(delivered()).toBe(1);

    await h.relaunch();
    // a retried send with the same sendId after relaunch must not duplicate
    const retry = await h.api("POST", `/api/bots/${bot.id}/messages`, {
      text: `${marker} what is this\n\n${h.image("123e4567-e89b-42d3-a456-426614175a01.png")}`,
      sendId: "qa-upd-image-0001",
    });
    expect([200, 202]).toContain(retry.status);
    await h.waitFor(async () => (await h.getBot(bot.id)).busy === false, "settle after relaunch", 30_000);
    await sleep(1500);
    const messages = (await h.getBot(bot.id)).messages;
    expect(messages.filter((m: any) => m.role === "user" && m.text?.includes(marker))).toHaveLength(1);
    expect(delivered()).toBe(1);
  }, 90_000);

  it("steer into a busy room after relaunch reaches the busy member once, same turn", async () => {
    const dev = await h.createBot("qaHold", "Dev");
    const room = (await h.api("POST", "/api/groups", {
      name: "QA updater room", memberIds: [dev.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: dev.id } },
    })).body.group;
    await h.relaunch();
    expect((await h.getGroup(room.id))?.id).toBe(room.id);

    await h.api("POST", `/api/groups/${room.id}/messages`, { text: "@Dev start" });
    await h.waitFor(async () => {
      const g = await h.getGroup(room.id);
      return !!g.activeBotIds?.includes(dev.id) && h.openCards(g.messages.filter((m: any) => m.from?.botId === dev.id)).length > 0;
    }, "room member parked after relaunch");
    const marker = "UPDROOM-steer";
    const body = { text: `@Dev ${marker} also this`, sendId: "qa-upd-room-0001" };
    const [a, b] = await Promise.all([h.api("POST", `/api/groups/${room.id}/messages`, body), h.api("POST", `/api/groups/${room.id}/messages`, body)]);
    expect(a.status).toBe(202);
    expect([200, 202]).toContain(b.status);
    await h.waitFor(async () => h.calls(h.roomNative(room.threadId, dev.id), "turn/steer", marker).length > 0, "room steer");
    await sleep(1000);
    expect(h.calls(h.roomNative(room.threadId, dev.id), "turn/steer", marker)).toHaveLength(1);
    expect(h.calls(h.roomNative(room.threadId, dev.id), "turn/start", marker)).toHaveLength(0);
    const g = await h.getGroup(room.id);
    expect(g.messages.filter((m: any) => m.text?.includes(marker) && !m.from?.botId)).toHaveLength(1);
  }, 90_000);
});

// ---------------------------------------------------------------------------
// Needs backend (dev/pipe-updater). Skips cleanly until the route exists.
// ---------------------------------------------------------------------------
const STATES = ["idle", "ready", "checkpointing", "stopping", "applying", "relaunching", "verifying", "done", "rolled_back", "failed"];

const makeBundle = (root: string, name: string, version: string, payload: string) => {
  const app = join(root, name);
  mkdirSync(join(app, "Contents", "Resources", "server"), { recursive: true });
  mkdirSync(join(app, "Contents", "Resources", "ui"), { recursive: true });
  writeFileSync(join(app, "Contents", "Info.plist"), `<plist><dict><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`);
  writeFileSync(join(app, "Contents", "Resources", "server", "index.js"), payload);
  writeFileSync(join(app, "Contents", "Resources", "ui", "index.html"), payload);
  return app;
};
const treeHash = (dir: string): string => {
  const h = createHash("sha256");
  const walk = (d: string, rel = "") => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name))) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p, `${rel}${e.name}/`);
      else { h.update(`${rel}${e.name}`); h.update(readFileSync(p)); }
    }
  };
  walk(dir);
  return h.digest("hex");
};

describe.skipIf(!posixOnly || !backendPresent)("updater acceptance: contract (needs backend)", () => {
  let h: Harness;
  let fault = "";
  let live: string;
  let staged: string;
  let jobs: string;
  let liveHashBefore: string;

  // The sandboxed updater relaunches by letting the harness exit; this keeps
  // restarting it on the same data dir, like launchd would.
  let supervising = false;
  const supervise = () => {
    supervising = true;
    void (async () => {
      while (supervising) {
        if (h.child && h.child.exitCode !== null) { try { await h.start(); } catch { /* retried */ } }
        await sleep(200);
      }
    })();
  };
  const status = async () => (await h.api("GET", "/api/update/status")).body;
  const waitTerminal = async (ms = 120_000) => {
    let s: any;
    await h.waitFor(async () => { s = await status(); return ["done", "rolled_back", "failed"].includes(s.state) || ["done", "rolled_back", "failed"].includes(s.lastResult?.state); }, "terminal update state", ms);
    return s;
  };
  const restage = () => {
    rmSync(join(h.home, "apps"), { recursive: true, force: true });
    live = makeBundle(join(h.home, "apps"), "BOS Bot.app", "1.2.0", "old build");
    staged = makeBundle(join(h.home, "apps", "staged"), "BOS Bot.app", "1.3.0", "new build");
    // copy, not reference: the test only ever touches its own bundle copies
    cpSync(staged, join(h.home, "apps", "staged-pristine.app"), { recursive: true });
    liveHashBefore = treeHash(live);
  };

  beforeAll(async () => {
    h = makeHarness("omb-upd-be-", () => ({
      OMB_UPDATE_SANDBOX: "1",
      OMB_UPDATE_APP_PATH: live,
      OMB_UPDATE_STAGED_PATH: staged,
      OMB_UPDATE_JOBS_DIR: jobs,
      ...(fault ? { OMB_UPDATE_FAULT: fault } : {}),
    }));
    jobs = join(h.home, "LaunchAgents");
    mkdirSync(jobs, { recursive: true });
    restage();
    await h.start();
    supervise();
  }, 30_000);
  afterAll(async () => { supervising = false; await h?.dispose(); });

  const reboot = async (nextFault = "") => { fault = nextFault; restage(); await h.relaunch(); };

  it("status shape matches the contract", async () => {
    const s = await status();
    expect(STATES).toContain(s.state);
    expect(s.current).toMatchObject({ version: expect.any(String), sha: expect.any(String) });
    expect(Array.isArray(s.busyTurns)).toBe(true);
    expect(s.candidate).toMatchObject({ version: "1.3.0", sha: expect.any(String), stagedAt: expect.anything() });
  });

  it("happy path: states progress in order, done, new sha reported", async () => {
    await reboot();
    const before = await status();
    const stream = h.collectEvents();
    const res = await h.api("POST", "/api/update/apply", {});
    expect(res.status).toBe(202);
    expect(res.body.updateId).toEqual(expect.any(String));
    const end = await waitTerminal();
    stream.close();
    expect(end.lastResult?.state ?? end.state).toBe("done");
    expect(end.current.sha).not.toBe(before.current.sha);
    expect(end.current.sha).toBe(before.candidate.sha);
    expect(treeHash(live)).toBe(treeHash(join(h.home, "apps", "staged-pristine.app")));
    const seen = stream.events.filter((e) => e.updateId === res.body.updateId).map((e) => e.state);
    const order = ["checkpointing", "stopping", "applying", "relaunching", "verifying", "done"];
    const idx = seen.map((s) => order.indexOf(s)).filter((i) => i >= 0);
    expect(idx).toEqual([...idx].sort((a, b) => a - b)); // monotone (events across relaunch may be missed, never reordered)
    expect(seen.length).toBeGreaterThan(0);
  }, 150_000);

  it("app killed mid-swap: recovers by rolling back, old bundle intact", async () => {
    await reboot("kill-mid-swap");
    expect((await h.api("POST", "/api/update/apply", { force: true })).status).toBe(202);
    const end = await waitTerminal();
    fault = "";
    expect(["rolled_back", "failed"]).toContain(end.lastResult?.state ?? end.state);
    expect(treeHash(live)).toBe(liveHashBefore);
    expect(await h.healthy()).toBe(true);
  }, 150_000);

  it("health fail after swap -> rolled_back with lastResult.rollback", async () => {
    await reboot("health-fail");
    expect((await h.api("POST", "/api/update/apply", { force: true })).status).toBe(202);
    const end = await waitTerminal();
    fault = "";
    expect(end.lastResult).toMatchObject({ state: "rolled_back", rollback: expect.anything(), detail: expect.any(String) });
    expect(treeHash(live)).toBe(liveHashBefore);
  }, 150_000);

  it("busy turn interrupted by update is resumed exactly once in the same thread", async () => {
    await reboot();
    const bot = await h.createBot("qaHold");
    const marker = "UPDRESUME-turn";
    await h.api("POST", `/api/bots/${bot.id}/messages`, { text: `${marker} keep going` });
    await h.waitFor(async () => (await h.getBot(bot.id)).busy === true, "busy turn");
    const s = await status();
    expect(s.busyTurns).toContainEqual(expect.objectContaining({ botId: bot.id, threadId: bot.threadId }));
    expect((await h.api("POST", "/api/update/apply", { force: true })).status).toBe(202);
    await waitTerminal();
    await h.waitFor(async () => h.calls(h.readNative(bot.threadId), "thread/resume", "").length > 0 || (await h.getBot(bot.id)).busy === true, "resume after relaunch", 30_000);
    await sleep(3000);
    const after = await h.getBot(bot.id);
    expect(after.threadId).toBe(bot.threadId);
    expect(after.messages.filter((m: any) => m.role === "user" && m.text?.includes(marker))).toHaveLength(1);
    // one original start + exactly one resumed continuation
    const starts = h.calls(h.readNative(bot.threadId), "turn/start", "");
    expect(starts.length).toBeLessThanOrEqual(2);
  }, 150_000);

  it("uncertain external action is not replayed; marked interrupted", async () => {
    await reboot();
    const bot = await h.createBot("qaHold");
    const marker = "UPDUNCERTAIN-action";
    await h.api("POST", `/api/bots/${bot.id}/messages`, { text: `${marker} do the thing` });
    // parked on an approval card = an external action whose outcome is unknown
    await h.waitFor(async () => h.openCards((await h.getBot(bot.id)).messages).length > 0, "pending external action");
    const before = h.calls(h.readNative(bot.threadId), "turn/start", marker).length;
    expect((await h.api("POST", "/api/update/apply", { force: true })).status).toBe(202);
    await waitTerminal();
    await sleep(3000);
    expect(h.calls(h.readNative(bot.threadId), "turn/start", marker).length).toBe(before);
    const msgs = (await h.getBot(bot.id)).messages;
    expect(msgs.some((m: any) => /interrupted/i.test(JSON.stringify(m.tool ?? m.text ?? m.card ?? "")))).toBe(true);
  }, 150_000);

  it("second concurrent apply -> 409", async () => {
    await reboot();
    const [a, b] = await Promise.all([h.api("POST", "/api/update/apply", {}), h.api("POST", "/api/update/apply", {})]);
    expect([a.status, b.status].sort()).toEqual([202, 409]);
    await waitTerminal();
  }, 150_000);

  it("restart uses the same checkpoint path and returns 202", async () => {
    await reboot();
    const res = await h.api("POST", "/api/update/restart", { force: true });
    expect(res.status).toBe(202);
    await h.waitFor(async () => await h.healthy() && (await status()).state !== "relaunching", "restart back up", 60_000);
    expect(treeHash(live)).toBe(liveHashBefore);
  }, 90_000);

  it("refuses when another updater/keepalive job exists", async () => {
    await reboot();
    // The previous restart can still be finishing after relaunch; admission
    // must be judged from an idle coordinator, not "already running".
    await h.waitFor(async () => ["idle", "ready"].includes((await status()).state), "coordinator idle before keepalive check", 60_000);
    writeFileSync(join(jobs, "ai.bos.bot.restart-keepalive.plist"), "<plist><dict><key>Label</key><string>ai.bos.bot.restart-keepalive</string><key>KeepAlive</key><true/></dict></plist>");
    const updates = join(h.data, "updates");
    const dirsBefore = existsSync(updates) ? readdirSync(updates).sort() : [];
    const stream = h.collectEvents();
    try {
      // Refused at admission, synchronously: 409 with the KeepAlive reason, no
      // updateId, no new update dir (so no checkpoint/plan), no state events,
      // coordinator still idle/ready. A later "failed" no longer passes.
      const res = await h.api("POST", "/api/update/apply", {});
      expect(res.status).toBe(409);
      expect(res.body.updateId).toBeUndefined();
      expect(res.body.error).toMatch(/^another installer or restart job is active: .*ai\.bos\.bot\.restart-keepalive \(KeepAlive\)/);
      await sleep(1500);
      const dirsAfter = existsSync(updates) ? readdirSync(updates).sort() : [];
      expect(dirsAfter).toEqual(dirsBefore);
      expect(existsSync(join(updates, "apply.lock"))).toBe(false);
      expect(stream.events.filter((e) => ["checkpointing", "stopping", "applying", "relaunching"].includes(e.state))).toEqual([]);
      const s = await status();
      expect(["idle", "ready"]).toContain(s.state);
      expect(treeHash(live)).toBe(liveHashBefore);
    } finally {
      stream.close();
      rmSync(join(jobs, "ai.bos.bot.restart-keepalive.plist"), { force: true });
    }
  }, 150_000);
});
