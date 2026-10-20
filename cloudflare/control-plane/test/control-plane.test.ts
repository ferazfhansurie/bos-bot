import { generateKeyPairSync, sign } from "node:crypto";
import { canonical } from "../../../electron/remote-full-protocol.mjs";
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { createAuth } from "../src/auth";
import { readConfig } from "../src/config";
import { buildOTPEmail, resendSender, sendOTPEmail } from "../src/email";
import worker from "../src/index";
import { sha256 } from "../src/installations";

const BASE_URL = "https://auth.openmausbot.test";

interface CallOptions {
  method?: string;
  token?: string;
  body?: unknown;
  rawBody?: string;
  bodyChunks?: string[];
  headers?: Record<string, string>;
  origin?: string;
}

async function call(path: string, options: CallOptions = {}) {
  const headers = new Headers(options.headers);
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  if (options.origin) headers.set("origin", options.origin);
  let body: BodyInit | undefined;
  if (options.bodyChunks) {
    const encoder = new TextEncoder();
    body = new ReadableStream({
      start(controller) {
        for (const chunk of options.bodyChunks ?? []) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
  } else if (options.rawBody !== undefined) body = options.rawBody;
  else if (options.body !== undefined) body = JSON.stringify(options.body);
  if (body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  const request = new Request(`${BASE_URL}${path}`, {
    method: options.method ?? "GET",
    headers,
    body,
  });
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function signIn(email: string) {
  const ctx = createExecutionContext();
  const auth = createAuth(env, ctx, readConfig(env), crypto.randomUUID());
  const otp = await auth.api.createVerificationOTP({ body: { email, type: "sign-in" } });
  await waitOnExecutionContext(ctx);
  const response = await call("/api/auth/sign-in/email-otp", {
    method: "POST",
    body: { email, otp, name: email.split("@", 1)[0] },
  });
  expect(response.status).toBe(200);
  const result = await response.json<{ token: string; user: { id: string; email: string } }>();
  const token = response.headers.get("set-auth-token");
  expect(token).toBeTruthy();
  if (!token) throw new Error("Better Auth did not return a signed bearer token");
  expect(result.user.email).toBe(email);
  return { token, rawToken: result.token, userId: result.user.id };
}

async function createInstall(
  token: string,
  clientInstanceId: string = crypto.randomUUID(),
  name = "Milind's Mac",
  platform: "darwin" | "windows" | "linux" = "darwin",
  appVersion: string | undefined = "0.1.0",
) {
  const response = await call("/v1/installations", {
    method: "POST",
    token,
    body: { clientInstanceId, name, platform, appVersion },
  });
  expect(response.status).toBe(201);
  return response.json<{
    installation: {
      id: string;
      clientInstanceId: string;
      name: string;
      platform: "darwin" | "windows" | "linux";
      appVersion: string | null;
      lastSeenAt: number | null;
    };
    credential: string;
    credentialExpiresAt: number;
  }>();
}

describe("control-plane migrations and health", () => {
  it("applies the pinned Better Auth and installation schemas in workerd", async () => {
    const rows = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all<{ name: string }>();
    expect(rows.results.map((row) => row.name)).toEqual(expect.arrayContaining([
      "account",
      "control_action_rate_limits",
      "installation_credentials",
      "installation_action_rate_limits",
      "installation_endpoints",
      "installations",
      "otp_recipient_rate_limits",
      "rateLimit",
      "session",
      "user",
      "verification",
    ]));

    const trigger = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = ?",
    ).bind("installations_active_limit_before_insert").first<{ name: string }>();
    expect(trigger?.name).toBe("installations_active_limit_before_insert");

    const rotationTriggers = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE ? ORDER BY name",
    ).bind("%rotation%").all<{ name: string }>();
    expect(rotationTriggers.results.map((row) => row.name)).toEqual([
      "installation_credentials_rotation_guard_before_insert",
      "installations_rotation_cooldown_before_update",
    ]);

    const fk = await env.DB.prepare("PRAGMA foreign_key_list(installation_credentials)").all<{ table: string }>();
    expect(fk.results.some((row) => row.table === "installations")).toBe(true);

    const endpointColumns = await env.DB.prepare("PRAGMA table_info(installation_endpoints)")
      .all<{ name: string }>();
    expect(endpointColumns.results.map((column) => column.name)).toEqual(expect.arrayContaining([
      "cleanup_attempts",
      "last_cleanup_attempt_at",
    ]));
  });

  it("serves a no-store health response without CORS wildcards", async () => {
    const response = await call("/healthz");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, service: "openmausbot-control-plane" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("reports an unhealthy deployment without exposing invalid configuration", async () => {
    const misconfiguredEnv: Env = {
      DB: env.DB,
      RESEND_API_KEY: env.RESEND_API_KEY,
      BETTER_AUTH_URL: env.BETTER_AUTH_URL,
      EMAIL_FROM: env.EMAIL_FROM,
      ALLOWED_ORIGINS: env.ALLOWED_ORIGINS,
      CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID,
      CLOUDFLARE_ZONE_ID: env.CLOUDFLARE_ZONE_ID,
      COMPANION_HOST_SUFFIX: env.COMPANION_HOST_SUFFIX,
      CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN,
      BETTER_AUTH_SECRET: "too-short",
    };
    const request = new Request(`${BASE_URL}/healthz`);
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, misconfiguredEnv, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).toBe('{"error":"misconfigured"}');
    expect(body).not.toContain("too-short");
  });

  it("reports a missing companion hostname suffix with a stable configuration error", () => {
    const missingSuffixEnv = { ...env };
    Reflect.deleteProperty(missingSuffixEnv, "COMPANION_HOST_SUFFIX");
    expect(() => readConfig(missingSuffixEnv)).toThrow(
      "COMPANION_HOST_SUFFIX must be a lowercase DNS suffix",
    );
  });
});

describe("Better Auth email OTP and bearer boundary", () => {
  it("sends enumeration-safe OTP responses and stores only a hash", async () => {
    const response = await call("/api/auth/email-otp/send-verification-otp", {
      method: "POST",
      body: { email: "new-user@example.com", type: "sign-in" },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true });
    expect(response.headers.get("cache-control")).toBe("no-store");

    const verification = await env.DB.prepare(
      'SELECT value FROM "verification" WHERE identifier = ?',
    ).bind("sign-in-otp-new-user@example.com").first<{ value: string }>();
    expect(verification?.value).toMatch(/^[A-Za-z0-9_-]{43}:0$/);
    expect(verification?.value).not.toMatch(/^\d{8}$/);
    const rateLimits = await env.DB.prepare('SELECT COUNT(*) AS count FROM "rateLimit"').first<{ count: number }>();
    expect(rateLimits?.count).toBeGreaterThan(0);

    await signIn("known-user@example.com");
    const knownResponse = await call("/api/auth/email-otp/send-verification-otp", {
      method: "POST",
      body: { email: "known-user@example.com", type: "sign-in" },
    });
    expect(knownResponse.status).toBe(response.status);
    await expect(knownResponse.json()).resolves.toEqual({ success: true });
  });

  it("limits OTP sends per recipient even when callers change addresses", async () => {
    const email = "recipient-limit@example.com";
    for (let index = 0; index < 3; index += 1) {
      const response = await call("/api/auth/email-otp/send-verification-otp", {
        method: "POST",
        headers: { "cf-connecting-ip": `198.51.100.${index + 1}` },
        body: { email, type: "sign-in" },
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ success: true });
    }

    const before = await env.DB.prepare(
      'SELECT value FROM "verification" WHERE identifier = ?',
    ).bind(`sign-in-otp-${email}`).first<{ value: string }>();
    expect(before?.value).toBeTruthy();

    const limited = await call("/api/auth/email-otp/send-verification-otp", {
      method: "POST",
      headers: { "cf-connecting-ip": "203.0.113.44" },
      body: { email, type: "sign-in" },
    });
    expect(limited.status).toBe(200);
    await expect(limited.json()).resolves.toEqual({ success: true });
    const after = await env.DB.prepare(
      'SELECT value FROM "verification" WHERE identifier = ?',
    ).bind(`sign-in-otp-${email}`).first<{ value: string }>();
    expect(after?.value).toBe(before?.value);

    const rateLimit = await env.DB.prepare(
      "SELECT attempts FROM otp_recipient_rate_limits",
    ).first<{ attempts: number }>();
    expect(rateLimit?.attempts).toBe(3);
  });

  it("canonicalizes Better Auth's message-only rate limit response", async () => {
    const responses = [];
    for (let index = 0; index < 6; index += 1) {
      responses.push(await call("/api/auth/email-otp/send-verification-otp", {
        method: "POST",
        headers: { "cf-connecting-ip": "198.51.100.42" },
        body: { email: `better-auth-limit-${index}@example.com`, type: "sign-in" },
      }));
    }

    expect(responses.slice(0, 5).map((response) => response.status)).toEqual([
      200,
      200,
      200,
      200,
      200,
    ]);
    const limited = responses[5];
    expect(limited.status).toBe(429);
    await expect(limited.json()).resolves.toEqual({ error: "rate_limited" });
    expect(limited.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("completes email OTP registration once and authenticates a bearer", async () => {
    const account = await signIn("ada@example.com");
    const me = await call("/v1/me", { token: account.token });
    expect(me.status).toBe(200);
    await expect(me.json()).resolves.toMatchObject({
      user: { id: account.userId, email: "ada@example.com", emailVerified: true },
    });
    expect((await call("/v1/me", { token: account.rawToken })).status).toBe(401);

    const accountAgain = await signIn("ada@example.com");
    expect(accountAgain.userId).toBe(account.userId);
    const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM "user" WHERE email = ?')
      .bind("ada@example.com").first<{ count: number }>();
    expect(count?.count).toBe(1);
  });

  it("rejects invalid, expired, and replayed OTPs and invalidates signed-out bearers", async () => {
    const invalidEmail = "invalid-otp@example.com";
    const invalidContext = createExecutionContext();
    const invalidAuth = createAuth(env, invalidContext, readConfig(env), crypto.randomUUID());
    const validOTP = await invalidAuth.api.createVerificationOTP({
      body: { email: invalidEmail, type: "sign-in" },
    });
    await waitOnExecutionContext(invalidContext);

    const invalid = await call("/api/auth/sign-in/email-otp", {
      method: "POST",
      body: { email: invalidEmail, otp: "00000000", name: "Invalid" },
    });
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toEqual({ error: "invalid_otp" });

    const accepted = await call("/api/auth/sign-in/email-otp", {
      method: "POST",
      body: { email: invalidEmail, otp: validOTP, name: "Valid" },
    });
    expect(accepted.status).toBe(200);
    const acceptedBody = await accepted.json<{ token: string }>();

    const replayed = await call("/api/auth/sign-in/email-otp", {
      method: "POST",
      body: { email: invalidEmail, otp: validOTP, name: "Replay" },
    });
    expect(replayed.status).toBe(400);
    await expect(replayed.json()).resolves.toEqual({ error: "invalid_otp" });

    const expiredEmail = "expired-otp@example.com";
    const expiredContext = createExecutionContext();
    const expiredAuth = createAuth(env, expiredContext, readConfig(env), crypto.randomUUID());
    const expiredOTP = await expiredAuth.api.createVerificationOTP({
      body: { email: expiredEmail, type: "sign-in" },
    });
    await waitOnExecutionContext(expiredContext);
    await env.DB.prepare(
      'UPDATE "verification" SET "expiresAt" = ? WHERE "identifier" = ?',
    ).bind(Date.now() - 1, `sign-in-otp-${expiredEmail}`).run();
    const expired = await call("/api/auth/sign-in/email-otp", {
      method: "POST",
      body: { email: expiredEmail, otp: expiredOTP, name: "Expired" },
    });
    expect(expired.status).toBe(400);
    await expect(expired.json()).resolves.toEqual({ error: "otp_expired" });

    const signedOut = await call("/api/auth/sign-out", {
      method: "POST",
      token: acceptedBody.token,
    });
    expect(signedOut.status).toBe(200);
    expect((await call("/v1/me", { token: acceptedBody.token })).status).toBe(401);
  });

  it("builds both plain-text and HTML OTP mail and redacts send failures", async () => {
    const message = buildOTPEmail("noreply@example.com", {
      email: "recipient@example.com",
      otp: "12345678",
      type: "sign-in",
    });
    expect(message.text).toContain("12345678");
    expect(message.html).toContain("12345678");

    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await sendOTPEmail({ send: async () => { throw new Error("recipient@example.com 12345678"); } },
      "noreply@example.com",
      { email: "recipient@example.com", otp: "12345678", type: "sign-in" },
      "request-safe");
    const logged = error.mock.calls.flat().join(" ");
    expect(logged).toContain("request-safe");
    expect(logged).not.toContain("recipient@example.com");
    expect(logged).not.toContain("12345678");
    error.mockRestore();
  });

  it("sends OTP mail through Resend and refuses without a key", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const okFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const message = buildOTPEmail("noreply@bosbot.my", { email: "to@example.com", otp: "12345678", type: "sign-in" });
    await resendSender("re_test", okFetch).send(message);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.resend.com/emails");
    expect(new Headers(calls[0].init.headers).get("authorization")).toBe("Bearer re_test");
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({
      from: "BOS Bot <noreply@bosbot.my>", to: ["to@example.com"], subject: "Your BOS Bot sign-in code",
    });

    const failFetch = (async () => new Response("no", { status: 403 })) as unknown as typeof fetch;
    await expect(resendSender("re_test", failFetch).send(message)).rejects.toThrow("resend 403");
    await expect(resendSender("", okFetch).send(message)).rejects.toThrow("email not configured");
    expect(calls).toHaveLength(1);
  });

  it("requires account bearers and never confuses installation credentials", async () => {
    expect((await call("/v1/me")).status).toBe(401);
    expect((await call("/v1/me", { token: "not-a-signed-session" })).status).toBe(401);
    expect((await call("/v1/me", { token: "omb_install_AAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" })).status).toBe(401);

    const account = await signIn("auth-boundary@example.com");
    expect((await call("/v1/installations/self", { token: account.token })).status).toBe(401);
  });
});

describe("installation lifecycle", () => {
  it("registers once, stores no raw credential, and serves installation self", async () => {
    const account = await signIn("owner@example.com");
    const created = await createInstall(account.token, "mac-stable-1");
    expect(created.credential).toMatch(/^omb_install_[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
    expect(created.credentialExpiresAt).toBeGreaterThan(Date.now() + 89 * 24 * 60 * 60 * 1_000);

    const stored = await env.DB.prepare(
      "SELECT lookup_id, secret_hash FROM installation_credentials WHERE installation_id = ?",
    ).bind(created.installation.id).first<{ lookup_id: string; secret_hash: string }>();
    expect(stored?.secret_hash).toBe(await sha256(created.credential));
    expect(JSON.stringify(stored)).not.toContain(created.credential);
    const entireRow = await env.DB.prepare(
      "SELECT * FROM installation_credentials WHERE installation_id = ?",
    ).bind(created.installation.id).first<{
      id: string;
      installation_id: string;
      lookup_id: string;
      secret_hash: string;
      created_at: number;
      expires_at: number;
      last_used_at: number | null;
      revoked_at: number | null;
    }>();
    expect(JSON.stringify(entireRow)).not.toContain(created.credential);

    const self = await call("/v1/installations/self", { token: created.credential });
    expect(self.status).toBe(200);
    const selfPayload = await self.json<{
      installation: { id: string; clientInstanceId: string; platform: string; appVersion: string; lastSeenAt: number };
      credentialExpiresAt: number;
    }>();
    expect(selfPayload).toMatchObject({
      installation: {
        id: created.installation.id,
        clientInstanceId: "mac-stable-1",
        platform: "darwin",
        appVersion: "0.1.0",
        lastSeenAt: expect.any(Number),
      },
    });
    expect(selfPayload.credentialExpiresAt).toBe(created.credentialExpiresAt);
    const used = await env.DB.prepare(
      "SELECT last_used_at FROM installation_credentials WHERE installation_id = ?",
    ).bind(created.installation.id).first<{ last_used_at: number | null }>();
    expect(used?.last_used_at).toEqual(expect.any(Number));
    const seen = await env.DB.prepare(
      "SELECT last_seen_at FROM installations WHERE id = ?",
    ).bind(created.installation.id).first<{ last_seen_at: number | null }>();
    expect(seen?.last_seen_at).toEqual(expect.any(Number));
  });

  it("enforces active client uniqueness per owner and permits re-registration after revocation", async () => {
    const first = await signIn("first@example.com");
    const second = await signIn("second@example.com");
    await createInstall(first.token, "stable-client");

    const duplicate = await call("/v1/installations", {
      method: "POST",
      token: first.token,
      body: { clientInstanceId: "stable-client", name: "Again", platform: "darwin" },
    });
    expect(duplicate.status).toBe(409);
    await expect(duplicate.json()).resolves.toEqual({ error: "installation_exists" });

    const crossAccount = await call("/v1/installations", {
      method: "POST",
      token: second.token,
      body: { clientInstanceId: "stable-client", name: "Independent", platform: "linux" },
    });
    expect(crossAccount.status).toBe(201);
    await expect(crossAccount.json()).resolves.toMatchObject({
      installation: { clientInstanceId: "stable-client", platform: "linux", appVersion: null },
    });

    const firstList = await call("/v1/installations", { token: first.token });
    const firstInstallation = (await firstList.json<{
      installations: Array<{ id: string; clientInstanceId: string }>;
    }>()).installations[0];
    expect((await call(`/v1/installations/${firstInstallation.id}`, {
      method: "DELETE",
      token: first.token,
    })).status).toBe(204);
    const registeredAgain = await createInstall(first.token, "stable-client", "Replacement Mac");
    expect(registeredAgain.installation.id).not.toBe(firstInstallation.id);
  });

  it("rejects expired installation credentials", async () => {
    const owner = await signIn("expiry@example.com");
    const created = await createInstall(owner.token);
    await env.DB.prepare(
      "UPDATE installation_credentials SET expires_at = ? WHERE installation_id = ?",
    ).bind(Date.now() - 1, created.installation.id).run();
    expect((await call("/v1/installations/self", { token: created.credential })).status).toBe(401);
  });

  it("caps active installations while allowing a slot to be reused after revocation", async () => {
    const owner = await signIn("installation-cap@example.com");
    const first = await createInstall(owner.token, "cap-client-0");
    const now = Date.now();
    await env.DB.batch(Array.from({ length: 99 }, (_, index) => env.DB.prepare(
      `INSERT INTO installations
        (id, owner_user_id, client_instance_id, display_name, platform, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'darwin', ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      owner.userId,
      `cap-client-${index + 1}`,
      `Cap Mac ${index + 1}`,
      now,
      now,
    )));

    const limited = await call("/v1/installations", {
      method: "POST",
      token: owner.token,
      body: { clientInstanceId: "cap-client-overflow", name: "Overflow", platform: "darwin" },
    });
    expect(limited.status).toBe(409);
    await expect(limited.json()).resolves.toEqual({ error: "installation_limit_reached" });

    expect((await call(`/v1/installations/${first.installation.id}`, {
      method: "DELETE",
      token: owner.token,
    })).status).toBe(204);
    expect((await call("/v1/installations", {
      method: "POST",
      token: owner.token,
      body: { clientInstanceId: "cap-client-replacement", name: "Replacement", platform: "darwin" },
    })).status).toBe(201);
  });

  it("rate-limits installation row creation for authenticated accounts", async () => {
    const owner = await signIn("creation-rate-limit@example.com");
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO control_action_rate_limits
        (user_id, action, window_started_at, attempts, updated_at)
       VALUES (?, 'create_installation', ?, 100, ?)`,
    ).bind(owner.userId, now, now).run();

    const limited = await call("/v1/installations", {
      method: "POST",
      token: owner.token,
      body: { clientInstanceId: "rate-limited", name: "Limited", platform: "darwin" },
    });
    expect(limited.status).toBe(429);
    await expect(limited.json()).resolves.toEqual({ error: "rate_limited" });
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM installations WHERE owner_user_id = ?",
    ).bind(owner.userId).first<{ count: number }>();
    expect(count?.count).toBe(0);
  });

  it("isolates every owner-scoped lookup", async () => {
    const owner = await signIn("owner-isolation@example.com");
    const other = await signIn("other-isolation@example.com");
    const created = await createInstall(owner.token);

    const list = await call("/v1/installations", { token: other.token });
    await expect(list.json()).resolves.toEqual({ installations: [] });
    expect((await call(`/v1/installations/${created.installation.id}/credentials/rotate`, {
      method: "POST",
      token: other.token,
    })).status).toBe(404);
    expect((await call(`/v1/installations/${created.installation.id}`, {
      method: "DELETE",
      token: other.token,
    })).status).toBe(404);
    expect((await call("/v1/installations/self", { token: created.credential })).status).toBe(200);
  });

  it("rotates then revokes credentials", async () => {
    const owner = await signIn("rotate@example.com");
    const created = await createInstall(owner.token);
    const rotated = await call(`/v1/installations/${created.installation.id}/credentials/rotate`, {
      method: "POST",
      token: owner.token,
    });
    expect(rotated.status).toBe(201);
    const next = await rotated.json<{ credential: string; credentialExpiresAt: number }>();
    expect(next.credential).not.toBe(created.credential);
    expect(next.credentialExpiresAt).toBeGreaterThan(Date.now() + 89 * 24 * 60 * 60 * 1_000);
    expect((await call("/v1/installations/self", { token: created.credential })).status).toBe(401);
    expect((await call("/v1/installations/self", { token: next.credential })).status).toBe(200);

    const revoked = await call(`/v1/installations/${created.installation.id}`, {
      method: "DELETE",
      token: owner.token,
    });
    expect(revoked.status).toBe(204);
    expect((await call("/v1/installations/self", { token: next.credential })).status).toBe(401);
    expect((await call(`/v1/installations/${created.installation.id}`, {
      method: "DELETE",
      token: owner.token,
    })).status).toBe(204);
  });

  it("serializes concurrent credential rotations", async () => {
    const owner = await signIn("concurrent-rotation@example.com");
    const created = await createInstall(owner.token);
    const rotatePath = `/v1/installations/${created.installation.id}/credentials/rotate`;
    const responses = await Promise.all([
      call(rotatePath, { method: "POST", token: owner.token }),
      call(rotatePath, { method: "POST", token: owner.token }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 429]);

    const successful = responses.find((response) => response.status === 201);
    if (!successful) throw new Error("one credential rotation must succeed");
    const payload = await successful.json<{ credential: string }>();
    expect((await call("/v1/installations/self", { token: payload.credential })).status).toBe(200);
  });
});

describe("HTTP boundary hardening", () => {
  it("rejects malformed, extra, unsupported, and oversized bodies", async () => {
    const owner = await signIn("validation@example.com");
    expect((await call("/v1/installations", {
      method: "POST",
      token: owner.token,
      rawBody: "not-json",
    })).status).toBe(400);
    expect((await call("/v1/installations", {
      method: "POST",
      token: owner.token,
      rawBody: "{}",
      headers: { "content-type": "text/plain" },
    })).status).toBe(415);
    expect((await call("/v1/installations", {
      method: "POST",
      token: owner.token,
      body: { clientInstanceId: "valid", name: "Mac", platform: "darwin", unexpected: true },
    })).status).toBe(400);
    expect((await call("/v1/installations", {
      method: "POST",
      token: owner.token,
      body: { clientInstanceId: "valid", name: "bad\nname", platform: "darwin" },
    })).status).toBe(400);
    expect((await call("/v1/installations", {
      method: "POST",
      token: owner.token,
      body: { clientInstanceId: "valid", name: "Mac", platform: "ios" },
    })).status).toBe(400);
    expect((await call("/v1/installations", {
      method: "POST",
      token: owner.token,
      body: { clientInstanceId: "valid", name: "Mac", platform: "darwin", appVersion: "x".repeat(65) },
    })).status).toBe(400);
    const oversized = await call("/v1/installations", {
      method: "POST",
      token: owner.token,
      rawBody: JSON.stringify({ clientInstanceId: "valid", name: "x".repeat(17 * 1024) }),
    });
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toEqual({ error: "request_too_large" });

    const chunkedAuthBody = [
      JSON.stringify({ email: "oversized@example.com", type: "sign-in", padding: "" }).slice(0, -2),
      "x".repeat(17 * 1024),
      '"}',
    ];
    const oversizedAuth = await call("/api/auth/email-otp/send-verification-otp", {
      method: "POST",
      bodyChunks: chunkedAuthBody,
    });
    expect(oversizedAuth.status).toBe(413);
    await expect(oversizedAuth.json()).resolves.toEqual({ error: "request_too_large" });
    const oversizedVerification = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM "verification" WHERE identifier LIKE ?',
    ).bind("%oversized@example.com%").first<{ count: number }>();
    expect(oversizedVerification?.count).toBe(0);
  });

  it("defaults CORS to deny and never emits a wildcard", async () => {
    const blocked = await call("/v1/me", { origin: "https://attacker.example" });
    expect(blocked.status).toBe(403);
    expect(blocked.headers.get("access-control-allow-origin")).toBeNull();
    let serializedHeaders = "";
    blocked.headers.forEach((value, name) => { serializedHeaders += `${name}: ${value}\n`; });
    expect(serializedHeaders).not.toContain("*");

    const allowed = await call("/v1/me", { origin: "https://app.openmausbot.test" });
    expect(allowed.status).toBe(401);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://app.openmausbot.test");
    expect(allowed.headers.get("cache-control")).toBe("no-store");

    const deniedPreflight = await call("/v1/installations", {
      method: "OPTIONS",
      origin: "https://app.openmausbot.test",
      headers: {
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization, x-unexpected",
      },
    });
    expect(deniedPreflight.status).toBe(403);
    expect(deniedPreflight.headers.get("access-control-allow-origin")).toBe("https://app.openmausbot.test");
  });
});


describe("remote Full installation owner authority", () => {
  const serverKeys = generateKeyPairSync("ed25519");
  const prepared = (challenge: unknown) => ({ challenge, serverSignature: Buffer.from(sign(null, Buffer.from(canonical(challenge)), serverKeys.privateKey)).toString("base64url") });
  const challenge = (installationId: string) => ({ protocol: "bos.remote-full.v1", nonce: "a".repeat(64), environmentId: "00000000-0000-4000-8000-000000000001", installationId,
    serverKey: serverKeys.publicKey.export({ format: "jwk" }).x!, audience: "https://fixture.invalid", expiresAt: Date.now() + 110_000,
    operations: [{ botId: "sol", threadId: "task", name: "Sol", title: "Exact task", modelSelection: { instanceId: "codex", model: "fixture" }, revision: "b".repeat(64), mode: "full", updateBotDefault: true }] });
  const scope = (c: ReturnType<typeof challenge>, ownerUserId: string) => ({ protocol: "bos.remote-full.enroll.v1", installationId: c.installationId,
    environmentId: c.environmentId, serverKey: c.serverKey, audience: c.audience, ownerUserId, expiresAt: Date.now() + 110_000, confirmation: "enroll-this-server" });
  const enroll = (c: ReturnType<typeof challenge>, token: string, credential: string, ownerUserId: string) => {
    const binding = scope(c, ownerUserId);
    return call("/v1/remote-full/enroll", { method: "POST", token, headers: { "x-installation-credential": credential },
      body: { binding, serverSignature: Buffer.from(sign(null, Buffer.from(canonical(binding)), serverKeys.privateKey)).toString("base64url") } });
  };
  const permit = async (c: ReturnType<typeof challenge>, ownerUserId: string) => {
    // Test-only operator provisioning. There is deliberately no HTTP issuer.
    await env.DB.prepare("INSERT INTO remote_full_enrollment_permits VALUES (?, ?, ?, ?, ?, ?)")
      .bind(c.environmentId, c.installationId, ownerUserId, c.serverKey, c.audience, Date.now() + 120_000).run();
  };
  it("requires installation proof to prepare and the actual account owner to authorize; revocation fails closed", async () => {
    const owner = await signIn("owner-full@example.com"), stranger = await signIn("stranger-full@example.com");
    const installed = await createInstall(owner.token), other = await createInstall(stranger.token);
    const c = challenge(installed.installation.id), ref = { installationId: c.installationId, nonce: c.nonce }, approval = { ...ref, challenge: c, signer: "a".repeat(43) };
    expect((await call("/v1/remote-full/prepare", { method: "POST", token: owner.token, body: prepared(c) })).status).toBe(401);
    expect((await call("/v1/remote-full/prepare", { method: "POST", token: other.credential, body: prepared(c) })).status).toBe(403);
    expect((await call("/v1/remote-full/prepare", { method: "POST", token: installed.credential, body: prepared(c) })).status).toBe(403);
    expect((await call("/v1/remote-full/authorize", { method: "POST", token: installed.credential, body: approval })).status).toBe(401);
    expect((await call("/v1/remote-full/authorize", { method: "POST", token: stranger.token, body: approval })).status).toBe(403);
    expect((await call("/v1/remote-full/authorize", { method: "POST", token: owner.token, body: { ...approval, challenge: { ...c, audience: "https://evil.invalid" } } })).status).toBe(403);
    expect((await call("/v1/remote-full/verify", { method: "POST", token: installed.credential, body: ref })).status).toBe(403);
    // Authorize cannot establish first ownership, even with a valid owner.
    expect((await call("/v1/remote-full/authorize", { method: "POST", token: owner.token, body: approval })).status).toBe(403);
    expect((await enroll(c, owner.token, installed.credential, owner.userId)).status).toBe(409);
    await permit(c, owner.userId);
    expect((await enroll(c, owner.token, installed.credential, owner.userId)).status).toBe(200);
    expect((await call("/v1/remote-full/prepare", { method: "POST", token: installed.credential, body: prepared(c) })).status).toBe(200);
    expect((await call("/v1/remote-full/authorize", { method: "POST", token: owner.token, body: approval })).status).toBe(200);
    const verified = await call("/v1/remote-full/verify", { method: "POST", token: installed.credential, body: ref });
    expect(verified.status).toBe(200); expect((await verified.json<{ ownerUserId: string }>()).ownerUserId).toBe(owner.userId);
    expect((await call("/v1/remote-full/authorize", { method: "POST", token: owner.token, body: approval })).status).toBe(403);
    const moved = { ...c, nonce: "c".repeat(64), environmentId: "different-server" };
    expect((await call("/v1/remote-full/prepare", { method: "POST", token: installed.credential, body: prepared(moved) })).status).toBe(403);
    expect((await call("/v1/remote-full/authorize", { method: "POST", token: owner.token, body: { ...approval, nonce: moved.nonce, challenge: moved } })).status).toBe(403);
    await call(`/v1/installations/${c.installationId}`, { method: "DELETE", token: owner.token });
    expect((await call("/v1/remote-full/verify", { method: "POST", token: installed.credential, body: ref })).status).toBe(401);
  });
  it("denies arbitrary first claims, mismatched owner/credential/key and expired permits", async () => {
    const owner = await signIn("enroll-owner@example.com"), other = await signIn("enroll-other@example.com");
    const installed = await createInstall(owner.token), stranger = await createInstall(other.token);
    const c = challenge(installed.installation.id);
    expect((await enroll(c, owner.token, installed.credential, owner.userId)).status).toBe(409);
    expect((await enroll(c, installed.credential, installed.credential, owner.userId)).status).toBe(401);
    expect((await enroll(c, owner.token, "paired-or-loopback-token", owner.userId)).status).toBe(401);
    await permit(c, owner.userId);
    expect((await enroll(c, other.token, installed.credential, other.userId)).status).toBe(409);
    expect((await enroll(c, owner.token, stranger.credential, owner.userId)).status).toBe(403);
    expect((await enroll({ ...c, serverKey: generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }).x! }, owner.token, installed.credential, owner.userId)).status).toBe(403);
    await env.DB.prepare("UPDATE remote_full_enrollment_permits SET expires_at = 0").run();
    expect((await enroll(c, owner.token, installed.credential, owner.userId)).status).toBe(409);
    expect(await env.DB.prepare("SELECT 1 FROM remote_full_bindings").first()).toBeNull();
  });
  it("concurrent first binding admits only the operator-reserved installation; ownership never transfers", async () => {
    const owner = await signIn("race-owner@example.com"), other = await signIn("race-other@example.com");
    const first = await createInstall(owner.token), second = await createInstall(other.token), sameOwner = await createInstall(owner.token);
    const c = challenge(first.installation.id), c2 = challenge(second.installation.id), c3 = challenge(sameOwner.installation.id);
    await permit(c, owner.userId);
    const responses = await Promise.all([enroll(c, owner.token, first.credential, owner.userId), enroll(c2, other.token, second.credential, other.userId), enroll(c, owner.token, first.credential, owner.userId)]);
    expect(responses.map(r => r.status)).toEqual([200, 409, 200]);
    expect((await enroll(c3, owner.token, sameOwner.credential, owner.userId)).status).toBe(409);
    // Even an erroneously replaced operator permit cannot overwrite a binding.
    await env.DB.prepare("UPDATE remote_full_enrollment_permits SET installation_id = ?, owner_user_id = ?").bind(c2.installationId, other.userId).run();
    expect((await enroll(c2, other.token, second.credential, other.userId)).status).toBe(409);
    await call(`/v1/installations/${c.installationId}`, { method: "DELETE", token: owner.token });
    expect((await enroll(c, owner.token, first.credential, owner.userId)).status).toBe(401);
    expect((await enroll(c2, other.token, second.credential, other.userId)).status).toBe(409);
    const rows = await env.DB.prepare("SELECT installation_id, owner_user_id FROM remote_full_bindings").all();
    expect(rows.results).toEqual([{ installation_id: c.installationId, owner_user_id: owner.userId }]);
    // DB uniqueness also holds against a second installation insert, not just API checks.
    await expect(env.DB.prepare("INSERT INTO remote_full_bindings (installation_id, environment_id, server_key, audience, owner_user_id, confirmed_at) VALUES (?, ?, ?, ?, ?, ?)").bind(c2.installationId, c.environmentId, c.serverKey, c.audience, other.userId, Date.now()).run()).rejects.toThrow(/UNIQUE/);
  });
  it("credential replacement invalidates previously authorized and prepared challenges", async () => {
    const owner = await signIn("rotate-full@example.com"), installed = await createInstall(owner.token), c = challenge(installed.installation.id);
    await permit(c, owner.userId); expect((await enroll(c, owner.token, installed.credential, owner.userId)).status).toBe(200);
    await call("/v1/remote-full/prepare", { method: "POST", token: installed.credential, body: prepared(c) });
    const ref = { installationId: c.installationId, nonce: c.nonce };
    expect((await call("/v1/remote-full/authorize", { method: "POST", token: owner.token, body: { ...ref, challenge: c, signer: "a".repeat(43) } })).status).toBe(200);
    const next = { ...c, nonce: "d".repeat(64) };
    await call("/v1/remote-full/prepare", { method: "POST", token: installed.credential, body: prepared(next) });
    const rotated = await call(`/v1/installations/${c.installationId}/credentials/rotate`, { method: "POST", token: owner.token });
    expect(rotated.status).toBe(201); const fresh = await rotated.json<{ credential: string }>();
    expect((await call("/v1/remote-full/verify", { method: "POST", token: installed.credential, body: ref })).status).toBe(401);
    expect((await call("/v1/remote-full/verify", { method: "POST", token: fresh.credential, body: ref })).status).toBe(403);
    expect((await call("/v1/remote-full/authorize", { method: "POST", token: owner.token, body: { installationId: c.installationId, nonce: next.nonce, challenge: next, signer: "a".repeat(43) } })).status).toBe(403);
  });
  it("legacy implicit bindings confer no authority until explicit enrollment with a permit", async () => {
    const owner = await signIn("legacy-full@example.com"), installed = await createInstall(owner.token), c = challenge(installed.installation.id);
    await env.DB.prepare("INSERT INTO remote_full_bindings (installation_id, environment_id, server_key, audience, owner_user_id, confirmed_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(c.installationId, c.environmentId, c.serverKey, c.audience, owner.userId, Date.now()).run();
    await call("/v1/remote-full/prepare", { method: "POST", token: installed.credential, body: prepared(c) });
    const approval = { installationId: c.installationId, nonce: c.nonce, challenge: c, signer: "a".repeat(43) };
    expect((await call("/v1/remote-full/authorize", { method: "POST", token: owner.token, body: approval })).status).toBe(403);
    expect((await enroll(c, owner.token, installed.credential, owner.userId)).status).toBe(409);
    await permit(c, owner.userId);
    expect((await enroll(c, owner.token, installed.credential, owner.userId)).status).toBe(200);
    expect((await call("/v1/remote-full/prepare", { method: "POST", token: installed.credential, body: prepared(c) })).status).toBe(200);
    expect((await call("/v1/remote-full/authorize", { method: "POST", token: owner.token, body: approval })).status).toBe(200);
  });
  it("readiness and prepare require the exact current binding, including after lost enrollment replies and revocation", async () => {
    const owner = await signIn("readiness-full@example.com"), installed = await createInstall(owner.token), c = challenge(installed.installation.id);
    const probeFor = (input = c) => ({ protocol: "bos.remote-full.status.v1", installationId: input.installationId,
      environmentId: input.environmentId, serverKey: input.serverKey, audience: input.audience, nonce: "e".repeat(64), expiresAt: Date.now() + 110_000 });
    const status = async (input = c, credential = installed.credential) => {
      const probe = probeFor(input);
      return call("/v1/remote-full/status", { method: "POST", token: credential, body: { probe, serverSignature: Buffer.from(sign(null, Buffer.from(canonical(probe)), serverKeys.privateKey)).toString("base64url") } });
    };
    const pending = await status(); expect(pending.status).toBe(200); expect(await pending.json()).toMatchObject({ enrolled: false });
    expect((await call("/v1/remote-full/prepare", { method: "POST", token: installed.credential, body: prepared(c) })).status).toBe(403);
    expect((await enroll(c, owner.token, installed.credential, owner.userId)).status).toBe(409);
    expect(await (await status()).json()).toMatchObject({ enrolled: false });
    await permit(c, owner.userId);
    // Simulate the client losing a committed enrollment response. A fresh
    // authenticated read proves the result without trusting local file state.
    await enroll(c, owner.token, installed.credential, owner.userId);
    expect(await (await status()).json()).toMatchObject({ enrolled: true, probe: { environmentId: c.environmentId, installationId: c.installationId, serverKey: c.serverKey, audience: c.audience } });
    expect((await enroll(c, owner.token, installed.credential, owner.userId)).status).toBe(200);
    const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM remote_full_challenges").first<{ n: number }>(); expect(before?.n).toBe(0);
    for (const wrong of [{ ...c, audience: "https://wrong.invalid" }, { ...c, environmentId: crypto.randomUUID() }]) {
      expect(await (await status(wrong)).json()).toMatchObject({ enrolled: false });
      expect((await call("/v1/remote-full/prepare", { method: "POST", token: installed.credential, body: prepared(wrong) })).status).toBe(403);
    }
    expect((await call("/v1/remote-full/prepare", { method: "POST", token: installed.credential, body: prepared(c) })).status).toBe(200);
    await env.DB.prepare("UPDATE remote_full_bindings SET explicitly_enrolled = 0").run();
    expect(await (await status()).json()).toMatchObject({ enrolled: false });
    expect((await call("/v1/remote-full/prepare", { method: "POST", token: installed.credential, body: prepared({ ...c, nonce: "f".repeat(64) }) })).status).toBe(403);
    await enroll(c, owner.token, installed.credential, owner.userId);
    const rotated = await call(`/v1/installations/${c.installationId}/credentials/rotate`, { method: "POST", token: owner.token });
    const fresh = await rotated.json<{ credential: string }>();
    expect((await status()).status).toBe(401); expect(await (await status(c, fresh.credential)).json()).toMatchObject({ enrolled: true });
    await call(`/v1/installations/${c.installationId}`, { method: "DELETE", token: owner.token });
    expect((await status(c, fresh.credential)).status).toBe(401);
    expect((await call("/v1/remote-full/prepare", { method: "POST", token: fresh.credential, body: prepared({ ...c, nonce: "f".repeat(64) }) })).status).toBe(401);
  });
  it("readiness rejects expired or wrongly signed probes and installation mismatches", async () => {
    const owner = await signIn("probe-full@example.com"), installed = await createInstall(owner.token), c = challenge(installed.installation.id);
    const good = { protocol: "bos.remote-full.status.v1", installationId: c.installationId, environmentId: c.environmentId, serverKey: c.serverKey, audience: c.audience, nonce: "a".repeat(64), expiresAt: Date.now() + 110_000 };
    for (const probe of [{ ...good, expiresAt: 1 }, { ...good, installationId: crypto.randomUUID() }, { ...good, serverKey: generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }).x! }]) {
      expect((await call("/v1/remote-full/status", { method: "POST", token: installed.credential, body: { probe, serverSignature: Buffer.from(sign(null, Buffer.from(canonical(probe)), serverKeys.privateKey)).toString("base64url") } })).status).toBe(403);
    }
  });
  it("rejects unregistered, expired and oversized-window challenges", async () => {
    const owner = await signIn("expiry-full@example.com"), installed = await createInstall(owner.token), c = challenge(installed.installation.id);
    for (const expiresAt of [Date.now()-1, Date.now()+180_000]) expect((await call("/v1/remote-full/prepare", { method: "POST", token: installed.credential, body: prepared({ ...c, expiresAt }) })).status).toBe(403);
    expect((await call("/v1/remote-full/authorize", { method: "POST", token: owner.token, body: { installationId: c.installationId, nonce: c.nonce, challenge: c, signer: "a".repeat(43) } })).status).toBe(403);
  });
});

it('fresh /v1/me accepts protected cookies and revocation cannot be restored by cookie cache', async () => {
  const account = await signIn('slice2-cookie@example.test');
  const cookie = '__Secure-better-auth.session_token='+encodeURIComponent(account.token);
  const first = await call('/v1/me',{headers:{cookie}});
  expect(first.status).toBe(200);
  await env.DB.prepare('DELETE FROM "session" WHERE "userId"=?').bind(account.userId).run();
  expect((await call('/v1/me',{headers:{cookie}})).status).toBe(401);
  expect((await call('/v1/me',{token:account.token})).status).toBe(401);
});
// branding compatibility (electron/branding-compat.json): data-home: existing desktop and companion homes, backups and lease recovery must open the same data; deployed-services: existing worker databases, service health identities and hosted addresses must not become a different service
