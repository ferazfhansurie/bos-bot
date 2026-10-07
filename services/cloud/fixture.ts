import {LocalObjects} from './objects.ts';
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm, mkdir, readdir } from "node:fs/promises";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import pg from "pg";
import { Database } from "./db.ts";
import { CloudService } from "./service.ts";
import { ControlPlaneIssuer } from "./identity.ts";
import { StubIssuer } from "./stub-issuer.ts";
import { FixtureHooks } from "./hooks.ts";
import { fixtureRoutes } from "./fixture-http.ts";
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
async function createFixture(automaticWorker = true, options?: {issuerURL: string; acceptanceHooks?: boolean}) {
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
      const migrations = new URL("./migrations/",import.meta.url);
      for (const name of (await readdir(migrations)).filter(v=>v.endsWith('.sql')).sort())
        await c.query(await readFile(new URL(name,migrations),'utf8'));
    } finally {
      await c.end();
    }
    const databaseUrl = `postgres://cloud_app@127.0.0.1:${pgPort}/${name}`;
    const url = `http://127.0.0.1:${httpPort}`;
    const hooks = new FixtureHooks();
    const issuer = options ? new ControlPlaneIssuer(options.issuerURL,url) : new StubIssuer(url);
    const key = randomBytes(32);
    const hookSecret = randomBytes(24).toString("base64url");
    const service = new CloudService(
      new Database(databaseUrl),
      issuer,
      url,
      key,
      hooks,
    );
    service.attachments.store = new LocalObjects(dir+'/objects',async(bytes,type)=>{
      // Fictional deterministic scanner for isolated acceptance only.
      if(bytes.includes(Buffer.from('EICAR')) || (type==='image/png'&&!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) || (type==='image/jpeg'&&!bytes.subarray(0,3).equals(Buffer.from([255,216,255]))) || (type==='application/pdf'&&!bytes.subarray(0,5).equals(Buffer.from('%PDF-'))) )return 'rejected';
      return 'clean';
    });
    app = await startCloud(
      service,
      httpPort,
      "127.0.0.1",
      (!options || options.acceptanceHooks) ? fixtureRoutes(service, hookSecret) : undefined,
      automaticWorker,
      new Set([url,...(process.env.CLOUD_ALLOWED_ORIGINS ?? "http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:5199").split(",")]),
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
export async function fixture(automaticWorker = true) {
  const f = await createFixture(automaticWorker);
  if (!(f.issuer instanceof StubIssuer)) throw new Error('fixture issuer mismatch');
  return {...f,issuer:f.issuer};
}
export async function realFixture(issuerURL: string, acceptanceHooks = false) {
  const f = await createFixture(true,{issuerURL,acceptanceHooks});
  if (!(f.issuer instanceof ControlPlaneIssuer)) throw new Error('real issuer mismatch');
  return {...f,issuer:f.issuer};
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
