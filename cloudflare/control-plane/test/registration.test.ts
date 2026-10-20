import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { createAuth } from "../src/auth";
import { readConfig } from "../src/config";
import worker from "../src/index";
import {
  INSTALLATION_OWNED_CAP,
  INSTALLATION_OWNED_EMAIL_DOMAIN,
  REGISTRATION_GLOBAL_MAX,
  REGISTRATION_PER_IP_MAX,
  reapLapsedInstallationOwned,
  registrationSource,
} from "../src/installations";

const BASE_URL = "https://auth.openmausbot.test";

async function call(
  path: string,
  options: { method?: string; token?: string; body?: unknown; ip?: string } = {},
) {
  const headers = new Headers();
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  if (options.ip) headers.set("cf-connecting-ip", options.ip);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  const request = new Request(`${BASE_URL}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

function register(clientInstanceId: string = crypto.randomUUID(), ip = "198.51.100.7") {
  return call("/v1/installations/register", {
    method: "POST",
    ip,
    body: { clientInstanceId, name: "Firaz's Mac", platform: "darwin", appVersion: "2.0.10" },
  });
}

interface Registered {
  installation: { id: string; clientInstanceId: string };
  credential: string;
  credentialExpiresAt: number;
}

describe("installation-owned registration", () => {
  it("creates an owner, an installation and a credential with no email or account bearer", async () => {
    const response = await register("silent-mac");
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json<Registered>();
    expect(body.credential).toMatch(/^omb_install_[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
    expect(body.installation.clientInstanceId).toBe("silent-mac");
    expect(body.credentialExpiresAt).toBeGreaterThan(Date.now());

    const self = await call("/v1/installations/self", { token: body.credential });
    expect(self.status).toBe(200);
    expect((await self.json<{ installation: { id: string } }>()).installation.id).toBe(body.installation.id);

    const owner = await env.DB.prepare(
      `SELECT u.email, u."emailVerified" AS verified
         FROM installations i JOIN "user" u ON u.id = i.owner_user_id
        WHERE i.id = ?`,
    ).bind(body.installation.id).first<{ email: string; verified: number }>();
    expect(owner?.email.endsWith(`@${INSTALLATION_OWNED_EMAIL_DOMAIN}`)).toBe(true);
    expect(owner?.verified).toBe(0);

    const stored = await env.DB.prepare("SELECT secret_hash FROM installation_credentials").all<{ secret_hash: string }>();
    expect(JSON.stringify(stored.results)).not.toContain(body.credential);

    // The installation credential is not an account bearer.
    expect((await call("/v1/me", { token: body.credential })).status).toBe(401);
    expect((await call("/v1/installations", { token: body.credential })).status).toBe(401);
  });

  it("never hands an existing installation to a second caller with the same client ID", async () => {
    const first = await (await register("shared-id")).json<Registered>();
    const second = await (await register("shared-id")).json<Registered>();
    expect(second.installation.id).not.toBe(first.installation.id);
    expect(second.credential).not.toBe(first.credential);
    expect((await call("/v1/installations/self", { token: first.credential })).status).toBe(200);
  });

  it("rejects malformed bodies", async () => {
    const response = await call("/v1/installations/register", {
      method: "POST",
      body: { clientInstanceId: "x", name: "Mac", platform: "darwin", extra: true },
    });
    expect(response.status).toBe(400);
  });

  it("rate-limits per caller IP", async () => {
    for (let index = 0; index < REGISTRATION_PER_IP_MAX; index += 1) {
      expect((await register(undefined, "203.0.113.9")).status).toBe(201);
    }
    const limited = await register(undefined, "203.0.113.9");
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "rate_limited" });
    expect((await register(undefined, "203.0.113.10")).status).toBe(201);

    // A new window admits the IP again.
    await env.DB.prepare("UPDATE installation_registration_limits SET window_started_at = ?")
      .bind(Date.now() - 61 * 60 * 1_000).run();
    expect((await register(undefined, "203.0.113.9")).status).toBe(201);
  });

  it("counts a whole IPv6 /64 as one caller", async () => {
    expect(registrationSource("2001:db8:0:1::5")).toBe("2001:db8:0:1::/64");
    expect(registrationSource("2001:0DB8:0000:0001:aaaa:bbbb:cccc:dddd")).toBe("2001:db8:0:1::/64");
    expect(registrationSource("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(registrationSource("::1")).toBe("0:0:0:0::/64");
    expect(registrationSource(" 203.0.113.9 ")).toBe("203.0.113.9");
    expect(registrationSource(null)).toBe("unknown");

    for (let index = 0; index < REGISTRATION_PER_IP_MAX; index += 1) {
      expect((await register(undefined, `2001:db8:0:7::${index + 1}`)).status).toBe(201);
    }
    expect((await register(undefined, "2001:db8:0:7:ffff::9")).status).toBe(429);
    expect((await register(undefined, "2001:db8:0:8::1")).status).toBe(201);
  });

  it("rate-limits globally across IPs", async () => {
    expect((await register(undefined, "192.0.2.1")).status).toBe(201);
    expect((await register(undefined, "192.0.2.2")).status).toBe(201);
    // Two per-IP buckets hold 1 attempt each; the shared global bucket holds 2.
    const filled = await env.DB.prepare("UPDATE installation_registration_limits SET attempts = ? WHERE attempts = 2")
      .bind(REGISTRATION_GLOBAL_MAX).run();
    expect(filled.meta.changes).toBe(1);
    const limited = await register(undefined, "192.0.2.3");
    expect(limited.status).toBe(429);
  });

  it("closes registration at the installation cap", async () => {
    const now = Date.now();
    const stamp = new Date(now).toISOString();
    const statements: D1PreparedStatement[] = [];
    for (let index = 0; index < INSTALLATION_OWNED_CAP; index += 1) {
      const userId = crypto.randomUUID();
      statements.push(
        env.DB.prepare(
          `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES (?, 'c', ?, 0, ?, ?)`,
        ).bind(userId, `${userId}@${INSTALLATION_OWNED_EMAIL_DOMAIN}`, stamp, stamp),
        env.DB.prepare("INSERT INTO installation_owned_accounts (user_id, created_at) VALUES (?, ?)").bind(userId, now),
        env.DB.prepare(
          `INSERT INTO installations (id, owner_user_id, client_instance_id, display_name, platform, created_at, updated_at)
           VALUES (?, ?, ?, 'c', 'darwin', ?, ?)`,
        ).bind(crypto.randomUUID(), userId, `cap-${index}`, now, now),
      );
    }
    for (let offset = 0; offset < statements.length; offset += 300) {
      await env.DB.batch(statements.slice(offset, offset + 300));
    }
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const closed = await register();
    expect(closed.status).toBe(503);
    expect(await closed.json()).toEqual({ error: "registration_closed" });

    await env.DB.prepare("UPDATE installations SET revoked_at = ? WHERE client_instance_id = 'cap-0'").bind(now).run();
    expect((await register()).status).toBe(201);
    vi.restoreAllMocks();
  });

  it("rotates its own credential and revokes itself", async () => {
    const registered = await (await register()).json<Registered>();
    const rotated = await call("/v1/installations/self/credentials/rotate", {
      method: "POST",
      token: registered.credential,
    });
    expect(rotated.status).toBe(201);
    const next = await rotated.json<{ credential: string; credentialExpiresAt: number }>();
    expect(next.credential).not.toBe(registered.credential);
    expect((await call("/v1/installations/self", { token: registered.credential })).status).toBe(401);
    expect((await call("/v1/installations/self", { token: next.credential })).status).toBe(200);

    const revoked = await call("/v1/installations/self", { method: "DELETE", token: next.credential });
    expect(revoked.status).toBe(204);
    expect((await call("/v1/installations/self", { token: next.credential })).status).toBe(401);
    expect((await call("/v1/installations/self", { method: "DELETE", token: next.credential })).status).toBe(401);
  });

  it("keeps self-rotation and self-revocation away from account-owned installations", async () => {
    const ctx = createExecutionContext();
    const auth = createAuth(env, ctx, readConfig(env), crypto.randomUUID());
    const email = "owner@example.com";
    const otp = await auth.api.createVerificationOTP({ body: { email, type: "sign-in" } });
    await waitOnExecutionContext(ctx);
    const signedIn = await call("/api/auth/sign-in/email-otp", { method: "POST", body: { email, otp, name: "owner" } });
    const token = signedIn.headers.get("set-auth-token");
    if (!token) throw new Error("missing bearer");
    const created = await call("/v1/installations", {
      method: "POST",
      token,
      body: { clientInstanceId: "account-mac", name: "Mac", platform: "darwin" },
    });
    const { credential } = await created.json<{ credential: string }>();
    expect((await call("/v1/installations/self/credentials/rotate", { method: "POST", token: credential })).status).toBe(403);
    expect((await call("/v1/installations/self", { method: "DELETE", token: credential })).status).toBe(403);
    expect((await call("/v1/installations/self", { token: credential })).status).toBe(200);
  });

  it("revokes installation-owned computers whose credential lapsed, and nothing else", async () => {
    const live = await (await register()).json<Registered>();
    const lapsed = await (await register()).json<Registered>();
    const now = Date.now();
    await env.DB.prepare("UPDATE installation_credentials SET expires_at = ? WHERE installation_id = ?")
      .bind(now - 1, lapsed.installation.id).run();
    // An account-owned installation with no live credential belongs to its owner.
    const ownerId = crypto.randomUUID();
    const stamp = new Date(now).toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES (?, 'p', ?, 1, ?, ?)`,
      ).bind(ownerId, `${ownerId}@example.com`, stamp, stamp),
      env.DB.prepare(
        `INSERT INTO installations (id, owner_user_id, client_instance_id, display_name, platform, created_at, updated_at)
         VALUES ('account-owned', ?, 'account-mac', 'Mac', 'darwin', ?, ?)`,
      ).bind(ownerId, now, now),
    ]);

    expect(await reapLapsedInstallationOwned(env, now)).toBe(1);
    const rows = await env.DB.prepare("SELECT id, revoked_at FROM installations").all<{ id: string; revoked_at: number | null }>();
    const revoked = Object.fromEntries(rows.results.map((row) => [row.id, row.revoked_at]));
    expect(revoked[lapsed.installation.id]).toBe(now);
    expect(revoked[live.installation.id]).toBeNull();
    expect(revoked["account-owned"]).toBeNull();
    expect((await call("/v1/installations/self", { token: live.credential })).status).toBe(200);
    expect(await reapLapsedInstallationOwned(env, now)).toBe(0);
  });

  it("refuses OTP mail to installation-owned addresses without revealing it", async () => {
    const response = await call("/api/auth/email-otp/send-verification-otp", {
      method: "POST",
      body: { email: `someone@${INSTALLATION_OWNED_EMAIL_DOMAIN}`, type: "sign-in" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    const stored = await env.DB.prepare('SELECT COUNT(*) AS total FROM "verification"').first<{ total: number }>();
    expect(stored?.total).toBe(0);
  });
});
