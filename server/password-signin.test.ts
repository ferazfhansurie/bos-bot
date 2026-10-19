import { compatEnv } from "../electron/branding-env.cjs";
// Staff logins: the owner makes a username + password on the loopback admin
// API, a remote browser signs in with it (or the phone number) and gets the
// same chat-only cookie session a pairing code would give. Removing the login
// or resetting the password ends that session.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PasswordLogins, generatePassword, normalizePhone } from "./password-signin.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const PORT = 29000 + Math.floor(Math.random() * 5000);
const HOST = "clinic.test";

let home: string;
let child: ChildProcess;
let stderr = "";

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: any;
}

/** remote: a foreign Host and a forwarded address, like a tunnel hands us. local: the owner on loopback. */
function call(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string>; from?: string; local?: boolean } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = init.body === undefined ? undefined : JSON.stringify(init.body);
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port: PORT,
        path,
        method: init.method ?? (payload ? "POST" : "GET"),
        headers: {
          ...(init.local ? { host: `127.0.0.1:${PORT}` } : { host: HOST, "x-forwarded-for": init.from ?? "203.0.113.7", "x-forwarded-proto": "https" }),
          ...(payload ? { "content-type": "application/json" } : {}),
          ...init.headers,
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          let body: unknown = raw;
          try {
            body = JSON.parse(raw);
          } catch {
            /* not json */
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const cookieOf = (reply: Reply): string => {
  const raw = reply.headers["set-cookie"];
  const first = Array.isArray(raw) ? raw[0] : raw;
  return (first ?? "").split(";")[0];
};
const asBrowser = (cookie: string) => ({ cookie, origin: `https://${HOST}` });

describe("password logins (unit)", () => {
  it("normalizes phone numbers so local and international forms match", () => {
    expect(normalizePhone("011-2182 0467")).toBe("601121820467");
    expect(normalizePhone("+60 11-2182 0467")).toBe("601121820467");
    expect(normalizePhone("12")).toBeNull();
  });

  it("generates readable passwords and stores only a hash, 0600", () => {
    expect(generatePassword()).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
    const dir = mkdtempSync(join(tmpdir(), "omb-pw-unit-"));
    const file = join(dir, "password-logins.json");
    const store = new PasswordLogins(file);
    const { login, password } = store.add({ name: "Uteh", username: "Uteh", phone: "011-2182 0467" });
    expect(login.username).toBe("uteh");
    const raw = readFileSync(file, "utf8");
    expect(raw).not.toContain(password);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const again = new PasswordLogins(file);
    expect(again.verify("uteh", password)?.id).toBe(login.id);
    expect(again.verify("+60112182 0467", password)?.id).toBe(login.id);
    expect(again.verify("uteh", password + "x")).toBeNull();
    expect(again.verify("nobody", password)).toBeNull();
    expect(() => again.add({ name: "Other", username: "uteh" })).toThrow(/taken/);
    expect(() => again.add({ name: "Other", username: "other", phone: "0112182 0467" })).toThrow(/phone/);
  });
});

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "omb-password-signin-"));
  const staticDir = join(home, "static");
  mkdirSync(join(home, ".openmausbot"), { recursive: true });
  mkdirSync(join(staticDir, "assets"), { recursive: true });
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>Served UI</title>");
  writeFileSync(join(home, ".openmausbot", "config.json"), JSON.stringify({ instances: { fixture: { driver: "password-signin-test-shadow" } } }));
  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: ROOT,
    env: {
      ...(compatEnv.PATH ? { PATH: compatEnv.PATH } : {}),
      ...(compatEnv.SystemRoot ? { SystemRoot: compatEnv.SystemRoot } : {}),
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(PORT),
      OMB_WEBHOOK_PORT: String(PORT + 1),
      OMB_STATIC_DIR: staticDir,
      OMB_PUBLIC_URL: `https://${HOST}`,
      OMB_ENVIRONMENT_LABEL: "clinic",
      OMB_BROWSER_CONNECTION: join(home, "browser-test-connection.json"),
      OMB_SSE_HEARTBEAT_MS: "50",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not start:\n${stderr}`);
}, 30_000);

afterAll(async () => {
  await waitForExit(child, { signal: "SIGTERM" });
  await removeTempDir(home);
});

describe("staff password sign-in on a server", () => {
  let memberId = "";
  let memberPassword = "";

  it("is off and unadvertised until the owner makes a login", async () => {
    expect((await call("/.well-known/openmausbot/environment")).body.capabilities.passwordSignIn).toBeUndefined();
    expect((await call("/api/auth/password", { body: { username: "x", password: "y" } })).status).toBe(404);
  });

  it("refuses to let a remote stranger or a client session make logins", async () => {
    const stranger = await call("/api/auth/password-logins", { body: { name: "Me", username: "me" }, headers: { origin: `https://${HOST}` } });
    expect([401, 403]).toContain(stranger.status);
  });

  it("the owner makes a member login and gets the password once", async () => {
    const created = await call("/api/auth/password-logins", { local: true, body: { name: "Uteh", username: "uteh", phone: "011-2182 0467" } });
    expect(created.status).toBe(200);
    expect(created.body.login).toMatchObject({ name: "Uteh", username: "uteh", phone: "601121820467", role: "member" });
    expect(created.body.password).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
    memberId = created.body.login.id;
    memberPassword = created.body.password;
    const listed = await call("/api/auth/password-logins", { local: true });
    expect(JSON.stringify(listed.body)).not.toContain(memberPassword);
    expect(listed.body.logins).toHaveLength(1);
    expect((await call("/.well-known/openmausbot/environment")).body.capabilities.passwordSignIn).toBe(true);
  });

  it("is JSON-only and refuses a wrong password without a cookie", async () => {
    const form = await new Promise<Reply>((resolve, reject) => {
      const req = httpRequest({ hostname: "127.0.0.1", port: PORT, path: "/api/auth/password", method: "POST", headers: { host: HOST, "x-forwarded-for": "203.0.113.9", "content-type": "application/x-www-form-urlencoded" } }, (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: raw }));
      });
      req.on("error", reject);
      req.end("username=uteh&password=x");
    });
    expect(form.status).toBe(415);
    const wrong = await call("/api/auth/password", { body: { username: "uteh", password: "nope-nope-nope" }, from: "203.0.113.20" });
    expect(wrong.status).toBe(401);
    expect(cookieOf(wrong)).toBe("");
  });

  it("signs in by username or phone into a chat-only cookie session named after the person", async () => {
    const byPhone = await call("/api/auth/password", { body: { username: "+60 11-2182 0467", password: memberPassword } });
    expect(byPhone.status).toBe(200);
    expect(byPhone.body.session).toMatchObject({ label: "Uteh", scopes: ["client"] });
    const cookie = cookieOf(byPhone);
    expect(String(byPhone.headers["set-cookie"])).toMatch(/HttpOnly/);
    const me = await call("/api/auth/session", { headers: asBrowser(cookie) });
    expect(me.body).toMatchObject({ kind: "session", label: "Uteh", scopes: ["client"], via: "cookie" });
    expect((await call("/api/bots", { headers: asBrowser(cookie) })).status).toBe(200);
    // chat-only: no settings, no making more logins
    expect((await call("/api/config", { method: "PUT", body: { language: "en" }, headers: asBrowser(cookie) })).status).toBe(403);
    expect((await call("/api/auth/password-logins", { body: { name: "Sneaky", username: "sneaky" }, headers: asBrowser(cookie) })).status).toBe(403);
  });

  it("binds staff to a stable member identity, streams updates and hides owner-private bots", async () => {
    const signIn = () => call("/api/auth/password", { body: { username: "uteh", password: memberPassword } });
    const first = await signIn();
    const headers = asBrowser(cookieOf(first));
    const me = await call("/api/multiplayer/me", { headers });
    expect(me.body).toMatchObject({ name: "Uteh", role: "member" });
    expect(me.body.actorId).toContain(`:person:password-${memberId}`);
    const second = await call("/api/multiplayer/me", { headers: asBrowser(cookieOf(await signIn())) });
    expect(second.body.actorId).toBe(me.body.actorId);
    const created = await call("/api/bots", { local: true, body: { name: "Owner private fixture" } });
    expect(created.status).toBe(201);
    const bot = created.body.bot;
    expect((await call(`/api/bots/${bot.id}`, { local: true, method: "PATCH", body: { visibility: "private" } })).status).toBe(200);
    const listed = await call("/api/bots", { headers });
    expect(listed.status).toBe(200);
    expect(listed.body.bots.some((b: any) => b.id === bot.id)).toBe(false);
    expect((await call(`/api/threads/${bot.threadId}/messages`, { headers })).status).toBe(404);
    // Read the first event only: the persistent stream must be usable, and
    // its initial snapshot must also exclude the private bot.
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest({ hostname: "127.0.0.1", port: PORT, path: "/api/events", headers: { host: HOST, "x-forwarded-for": "203.0.113.7", "x-forwarded-proto": "https", ...headers } }, (res) => {
        expect(res.statusCode).toBe(200);
        res.once("data", chunk => {
          try { expect(String(chunk)).not.toContain(bot.id); resolve(); } catch (error) { reject(error); }
          res.destroy();
        });
      });
      req.setTimeout(5000, () => req.destroy(new Error("no event arrived")));
      req.on("error", reject);
      req.end();
    });
  });

  it("only an admin can change a staff role; existing devices must sign in again", async () => {
    const signIn = () => call("/api/auth/password", { body: { username: "uteh", password: memberPassword } });
    const old = cookieOf(await signIn());
    const route = `/api/auth/password-logins/${memberId}`;
    expect((await call(route, { method: "PATCH", body: { role: "admin" }, headers: asBrowser(old) })).status).toBe(403);
    expect((await call(route, { local: true, method: "PATCH", body: { role: "owner" } })).status).toBe(400);
    expect((await call(route, { local: true, method: "PATCH", body: { role: "admin", scopes: ["peer"] } })).status).toBe(400);
    const promoted = await call(route, { local: true, method: "PATCH", body: { role: "admin" } });
    expect(promoted.status).toBe(200);
    expect(promoted.body).toMatchObject({ login: { role: "admin" }, signInRequired: true });
    expect(JSON.stringify(promoted.body)).not.toMatch(/"(?:hash|salt|password)":/);
    expect((await call("/api/auth/session", { headers: asBrowser(old) })).status).toBe(401);
    const admin = cookieOf(await signIn());
    expect((await call("/api/auth/session", { headers: asBrowser(admin) })).body.scopes).toEqual(["admin", "client"]);
    expect((await call("/api/connectors/catalog", { headers: asBrowser(admin) })).status).toBe(200);
    expect((await call("/api/mcp-servers", { headers: asBrowser(admin) })).status).not.toBe(403);
    const unchanged = await call(route, { local: true, method: "PATCH", body: { role: "admin" } });
    expect(unchanged.body.signInRequired).toBe(false);
    expect((await call("/api/auth/session", { headers: asBrowser(admin) })).status).toBe(200);
    expect((await call(route, { local: true, method: "PATCH", body: { role: "member" } })).status).toBe(200);
    expect((await call("/api/auth/session", { headers: asBrowser(admin) })).status).toBe(401);
    expect((await call("/api/auth/session", { headers: asBrowser(cookieOf(await signIn())) })).body.scopes).toEqual(["client"]);
  });

  it("rechecks admin authority after a delayed role-change body", async () => {
    const created = await call("/api/auth/password-logins", { local: true, body: { name: "Delayed admin", username: "delayed-admin", role: "admin" } });
    const signed = await call("/api/auth/password", { body: { username: "delayed-admin", password: created.body.password } });
    let finish!: () => void;
    const result = new Promise<number>((resolve, reject) => {
      const req = httpRequest({ hostname: "127.0.0.1", port: PORT, path: `/api/auth/password-logins/${created.body.login.id}`, method: "PATCH", headers: { host: HOST, "x-forwarded-for": "203.0.113.71", "content-type": "application/json", "transfer-encoding": "chunked", ...asBrowser(cookieOf(signed)) } }, res => {
        res.resume(); res.on("end", () => resolve(res.statusCode ?? 0));
      });
      req.on("error", reject);
      req.write('{"role":');
      finish = () => req.end('"admin"}');
    });
    // Give the initial request a turn to enter readBody, then demote it.
    await new Promise(resolve => setTimeout(resolve, 100));
    expect((await call(`/api/auth/password-logins/${created.body.login.id}`, { local: true, method: "PATCH", body: { role: "member" } })).status).toBe(200);
    finish();
    expect(await result).toBe(403);
    const again = await call("/api/auth/password", { body: { username: "delayed-admin", password: created.body.password } });
    expect(again.body.session.scopes).toEqual(["client"]);
  });

  it("resetting the password ends the old session and the old password", async () => {
    const signed = await call("/api/auth/password", { body: { username: "uteh", password: memberPassword } });
    const cookie = cookieOf(signed);
    const reset = await call(`/api/auth/password-logins/${memberId}/reset`, { local: true, method: "POST", body: {} });
    expect(reset.status).toBe(200);
    expect(reset.body.password).not.toBe(memberPassword);
    expect((await call("/api/auth/session", { headers: asBrowser(cookie) })).status).toBe(401);
    expect((await call("/api/auth/password", { body: { username: "uteh", password: memberPassword }, from: "203.0.113.21" })).status).toBe(401);
    memberPassword = reset.body.password;
  });

  it("an admin login gets admin scope; removing a login ends its sessions", async () => {
    const created = await call("/api/auth/password-logins", { local: true, body: { name: "Clinic Owner", username: "owner", role: "admin" } });
    const admin = await call("/api/auth/password", { body: { username: "owner", password: created.body.password } });
    expect(admin.body.session.scopes).toEqual(["admin", "client"]);
    const member = await call("/api/auth/password", { body: { username: "uteh", password: memberPassword } });
    const memberCookie = cookieOf(member);
    const removed = await call(`/api/auth/password-logins/${memberId}`, { method: "DELETE", headers: asBrowser(cookieOf(admin)) });
    expect(removed.status).toBe(200);
    expect((await call("/api/auth/session", { headers: asBrowser(memberCookie) })).status).toBe(401);
    expect((await call("/api/auth/password", { body: { username: "uteh", password: memberPassword }, from: "203.0.113.22" })).status).toBe(401);
  });

  it("enforces lockout even when concurrent requests deliver bodies late", async () => {
    const pending = Array.from({ length: 16 }, () => {
      let finish!: () => void;
      const result = new Promise<number>((resolve, reject) => {
        const req = httpRequest({ hostname: "127.0.0.1", port: PORT, path: "/api/auth/password", method: "POST", headers: { host: HOST, "x-forwarded-for": "203.0.113.60", "content-type": "application/json", "transfer-encoding": "chunked" } }, res => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        });
        req.on("error", reject);
        req.write('{"username":"owner",');
        finish = () => req.end('"password":"wrong"}');
      });
      return { result, finish };
    });
    // All handlers wait for the rest of their JSON before any failures occur.
    await new Promise(resolve => setTimeout(resolve, 100));
    pending.forEach(request => request.finish());
    const statuses = await Promise.all(pending.map(request => request.result));
    expect(statuses).toContain(429);
    expect(statuses.filter(status => status === 401).length).toBeLessThan(16);
    expect(statuses.every(status => status === 401 || status === 429)).toBe(true);
  });

  it("locks out a source after repeated wrong passwords", async () => {
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await call("/api/auth/password", { body: { username: "owner", password: "wrong" }, from: "203.0.113.50" })).status;
    expect(last).toBe(429);
  });
});
