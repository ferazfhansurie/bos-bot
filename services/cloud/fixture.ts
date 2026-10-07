import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import pg from "pg";
import { Database } from "./db.ts";
import { CloudService } from "./service.ts";
import { StubIssuer } from "./identity.ts";
import { FixtureHooks } from "./hooks.ts";
import { startCloud } from "./http.ts";
async function freePort() {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const p = (s.address() as any).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}
async function command(bin: string, args: string[]) {
  const p = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  p.stdout.on("data", (s) => (out += s));
  p.stderr.on("data", (s) => (out += s));
  const code = await new Promise<number | null>((r, j) => {
    p.on("error", j);
    p.on("exit", r);
  });
  if (code !== 0) throw new Error(bin + " failed: " + out);
  return out;
}
export async function fixture(automaticWorker = true) {
  const root = resolve(new URL("./.fixture/", import.meta.url).pathname);
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(root + "/run-");
  const pgPort = await freePort(),
    httpPort = await freePort(),
    name = "cloud_slice1_" + randomBytes(5).toString("hex");
  let postgres: ReturnType<typeof spawn> | undefined,
    app: Awaited<ReturnType<typeof startCloud>> | undefined;
  const stop = async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
    if (postgres) {
      const p = postgres;
      postgres = undefined;
      const done = new Promise<void>((r) => {
        if (p.exitCode !== null) r();
        else p.once("exit", () => r());
      });
      p.kill("SIGTERM");
      await done;
    }
    await rm(dir, { recursive: true, force: true });
  };
  try {
    await command("/opt/homebrew/bin/initdb", [
      "-D",
      dir + "/pg",
      "-U",
      "cloud_migrator",
      "--auth=trust",
      "--encoding=UTF8",
      "--no-locale",
    ]);
    await writeFile(dir + "/pg.log", "");
    postgres = spawn(
      "/opt/homebrew/bin/postgres",
      [
        "-D",
        dir + "/pg",
        "-h",
        "127.0.0.1",
        "-p",
        String(pgPort),
        "-k",
        "",
        "-c",
        "shared_buffers=16MB",
        "-c",
        "max_connections=30",
        "-c",
        "fsync=on",
        "-c",
        "synchronous_commit=on",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let logs = "";
    postgres.stdout!.on("data", (v) => (logs += v));
    postgres.stderr!.on("data", (v) => (logs += v));
    postgres.on("error", () => {});
    const adminUrl = `postgres://cloud_migrator@127.0.0.1:${pgPort}/postgres`;
    let connected = false;
    for (let n = 0; n < 50; n++) {
      const c = new pg.Client({
        connectionString: adminUrl,
        connectionTimeoutMillis: 200,
      });
      try {
        await c.connect();
        await c.query("CREATE DATABASE " + name);
        connected = true;
        break;
      } catch {
        if (postgres.exitCode !== null) throw new Error(logs);
        await new Promise((r) => setTimeout(r, 100));
      } finally {
        await c.end().catch(() => {});
      }
    }
    if (!connected) throw new Error("local postgres startup timed out");
    const migrationUrl = adminUrl.replace("/postgres", "/" + name);
    const c = new pg.Client({ connectionString: migrationUrl });
    await c.connect();
    try {
      await c.query(
        await readFile(
          new URL("./migrations/001.sql", import.meta.url),
          "utf8",
        ),
      );
    } finally {
      await c.end();
    }
    const databaseUrl = `postgres://cloud_app@127.0.0.1:${pgPort}/${name}`;
    const url = `http://127.0.0.1:${httpPort}`;
    const hooks = new FixtureHooks();
    const issuer = new StubIssuer(url);
    const key = randomBytes(32);
    const hookSecret = randomBytes(24).toString("base64url");
    const service = new CloudService(
      new Database(databaseUrl),
      issuer,
      url,
      key,
      hooks,
    );
    app = await startCloud(
      service,
      httpPort,
      "127.0.0.1",
      hookSecret,
      automaticWorker,
    );
    const state = {
      url,
      ws_url: url.replace("http:", "ws:") + "/v2/realtime",
      database_url: databaseUrl,
      migration_url: migrationUrl,
      fixture_directory: dir,
      hook_secret: hookSecret,
      postgres_pid: postgres.pid,
      fixture_pid: process.pid,
      schema: 1,
    };
    await writeFile(dir + "/state.json", JSON.stringify(state, null, 2), {
      mode: 0o600,
    });
    return { ...state, service, hooks, issuer, app, stop };
  } catch (e) {
    await stop();
    throw e;
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === new URL(import.meta.url).pathname
) {
  const f = await fixture();
  console.log(
    JSON.stringify({
      url: f.url,
      ws_url: f.ws_url,
      database_url: f.database_url,
      migration_url: f.migration_url,
      state_path: f.fixture_directory + "/state.json",
      postgres_pid: f.postgres_pid,
      fixture_pid: f.fixture_pid,
      schema: 1,
    }),
  );
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await f.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
