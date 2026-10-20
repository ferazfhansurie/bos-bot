import { z } from "zod";
import { timingSafeEqual } from "node:crypto";

import type { ControlPlaneAuth } from "./auth";
import { accountSession } from "./auth";
import { HTTPError, json, readBoundedJSON } from "./http";

interface InstallationRow {
  id: string;
  client_instance_id: string;
  display_name: string;
  platform: "darwin" | "windows" | "linux";
  app_version: string | null;
  created_at: number;
  updated_at: number;
  last_seen_at: number | null;
}

interface OwnedInstallationRow extends InstallationRow {
  revoked_at: number | null;
}

interface InstallationCredentialRow {
  installation_id: string;
  lookup_id: string;
  secret_hash: string;
  display_name: string;
  client_instance_id: string;
  platform: "darwin" | "windows" | "linux";
  app_version: string | null;
  created_at: number;
  updated_at: number;
  last_seen_at: number | null;
  expires_at: number;
}

function printableString(maxLength: number) {
  return z.string().trim().min(1).max(maxLength).refine((value) => {
    for (const character of value) {
      const point = character.codePointAt(0);
      if (point === undefined || point < 32 || point === 127) return false;
    }
    return true;
  });
}

const printableName = printableString(80);
const printableVersion = printableString(64);

const createInstallationSchema = z.strictObject({
  name: printableName,
  clientInstanceId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  platform: z.enum(["darwin", "windows", "linux"]),
  appVersion: printableVersion.optional(),
});

const INSTALLATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INSTALLATION_CREDENTIAL = /^omb_install_([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;
const INSTALLATION_CREDENTIAL_TTL_MS = 90 * 24 * 60 * 60 * 1_000;
const CREATION_RATE_WINDOW_MS = 60 * 60 * 1_000;
const CREATION_RATE_MAX_ATTEMPTS = 100;

function installationJSON(row: InstallationRow) {
  return {
    id: row.id,
    clientInstanceId: row.client_instance_id,
    name: row.display_name,
    platform: row.platform,
    appVersion: row.app_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSeenAt: row.last_seen_at,
  };
}

function base64URL(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function randomBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return bytes;
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fromHex(value: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/.test(value)) return null;
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export async function sha256(value: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function newCredential(createdAt: number) {
  const lookupId = base64URL(randomBytes(16));
  const secret = base64URL(randomBytes(32));
  const raw = `omb_install_${lookupId}.${secret}`;
  return {
    lookupId,
    raw,
    secretHash: await sha256(raw),
    expiresAt: createdAt + INSTALLATION_CREDENTIAL_TTL_MS,
  };
}

async function requireAccount(request: Request, auth: ControlPlaneAuth) {
  const session = await accountSession(request, auth);
  if (!session) throw new HTTPError(401, "unauthorized");
  return session;
}

async function enforceCreationRateLimit(ownerUserId: string, env: Env): Promise<void> {
  const now = Date.now();
  const cutoff = now - CREATION_RATE_WINDOW_MS;
  const result = await env.DB.prepare(
    `INSERT INTO control_action_rate_limits
      (user_id, action, window_started_at, attempts, updated_at)
     VALUES (?, 'create_installation', ?, 1, ?)
     ON CONFLICT(user_id, action) DO UPDATE SET
       window_started_at = CASE
         WHEN window_started_at <= ? THEN excluded.window_started_at
         ELSE window_started_at
       END,
       attempts = CASE
         WHEN window_started_at <= ? THEN 1
         ELSE attempts + 1
       END,
       updated_at = excluded.updated_at
     WHERE window_started_at <= ? OR attempts < ?`,
  ).bind(
    ownerUserId,
    now,
    now,
    cutoff,
    cutoff,
    cutoff,
    CREATION_RATE_MAX_ATTEMPTS,
  ).run();
  if (result.meta.changes === 0) throw new HTTPError(429, "rate_limited");
}

export async function listInstallations(request: Request, env: Env, auth: ControlPlaneAuth): Promise<Response> {
  const session = await requireAccount(request, auth);
  const result = await env.DB.prepare(
    `SELECT id, client_instance_id, display_name, platform, app_version,
            created_at, updated_at, last_seen_at
       FROM installations
      WHERE owner_user_id = ? AND revoked_at IS NULL
      ORDER BY created_at ASC, id ASC
      LIMIT 100`,
  ).bind(session.user.id).all<InstallationRow>();
  return json({ installations: result.results.map(installationJSON) });
}

export async function createInstallation(request: Request, env: Env, auth: ControlPlaneAuth): Promise<Response> {
  const session = await requireAccount(request, auth);
  await enforceCreationRateLimit(session.user.id, env);
  const parsed = createInstallationSchema.safeParse(await readBoundedJSON(request));
  if (!parsed.success) throw new HTTPError(400, "invalid_request");

  const installationId = crypto.randomUUID();
  const credentialId = crypto.randomUUID();
  const now = Date.now();
  const credential = await newCredential(now);
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO installations
          (id, owner_user_id, client_instance_id, display_name, platform, app_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        installationId,
        session.user.id,
        parsed.data.clientInstanceId,
        parsed.data.name,
        parsed.data.platform,
        parsed.data.appVersion ?? null,
        now,
        now,
      ),
      env.DB.prepare(
        `INSERT INTO installation_credentials
          (id, installation_id, lookup_id, secret_hash, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(credentialId, installationId, credential.lookupId, credential.secretHash, now, credential.expiresAt),
    ]);
  } catch (error) {
    if (error instanceof Error && /active_installation_limit/i.test(error.message)) {
      throw new HTTPError(409, "installation_limit_reached");
    }
    if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) {
      throw new HTTPError(409, "installation_exists");
    }
    throw error;
  }

  return json({
    installation: {
      id: installationId,
      clientInstanceId: parsed.data.clientInstanceId,
      name: parsed.data.name,
      platform: parsed.data.platform,
      appVersion: parsed.data.appVersion ?? null,
      createdAt: now,
      updatedAt: now,
      lastSeenAt: null,
    },
    credential: credential.raw,
    credentialExpiresAt: credential.expiresAt,
  }, 201);
}

async function ownedActiveInstallation(id: string, ownerUserId: string, env: Env) {
  if (!INSTALLATION_ID.test(id)) return null;
  return env.DB.prepare(
    `SELECT id, client_instance_id, display_name, platform, app_version,
            created_at, updated_at, last_seen_at
       FROM installations
      WHERE id = ? AND owner_user_id = ? AND revoked_at IS NULL`,
  ).bind(id, ownerUserId).first<InstallationRow>();
}

async function ownedInstallation(id: string, ownerUserId: string, env: Env) {
  if (!INSTALLATION_ID.test(id)) return null;
  return env.DB.prepare(
    `SELECT id, client_instance_id, display_name, platform, app_version,
            created_at, updated_at, last_seen_at, revoked_at
       FROM installations
      WHERE id = ? AND owner_user_id = ?`,
  ).bind(id, ownerUserId).first<OwnedInstallationRow>();
}

async function rotateCredentialRows(installationId: string, env: Env, ownerUserId: string | null) {
  const now = Date.now();
  const credential = await newCredential(now);
  try {
    await env.DB.batch([
      ownerUserId === null
        ? env.DB.prepare(
          `UPDATE installations
              SET updated_at = ?, last_rotation_at = ?
            WHERE id = ? AND revoked_at IS NULL`,
        ).bind(now, now, installationId)
        : env.DB.prepare(
          `UPDATE installations
              SET updated_at = ?, last_rotation_at = ?
            WHERE id = ? AND owner_user_id = ? AND revoked_at IS NULL`,
        ).bind(now, now, installationId, ownerUserId),
      env.DB.prepare(
        `UPDATE installation_credentials
            SET revoked_at = ?
          WHERE installation_id = ? AND revoked_at IS NULL`,
      ).bind(now, installationId),
      env.DB.prepare(
        `INSERT INTO installation_credentials
          (id, installation_id, lookup_id, secret_hash, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        installationId,
        credential.lookupId,
        credential.secretHash,
        now,
        credential.expiresAt,
      ),
    ]);
  } catch (error) {
    if (error instanceof Error && /credential_rotation_rate_limited/i.test(error.message)) {
      throw new HTTPError(429, "credential_rotation_rate_limited");
    }
    if (error instanceof Error && /credential_rotation_conflict/i.test(error.message)) {
      throw new HTTPError(409, "credential_rotation_conflict");
    }
    throw error;
  }
  return json({ credential: credential.raw, createdAt: now, credentialExpiresAt: credential.expiresAt }, 201);
}

export async function rotateInstallationCredential(
  request: Request,
  installationId: string,
  env: Env,
  auth: ControlPlaneAuth,
): Promise<Response> {
  const session = await requireAccount(request, auth);
  const installation = await ownedActiveInstallation(installationId, session.user.id, env);
  if (!installation) throw new HTTPError(404, "not_found");
  return rotateCredentialRows(installationId, env, session.user.id);
}

export async function revokeInstallation(
  request: Request,
  installationId: string,
  env: Env,
  auth: ControlPlaneAuth,
): Promise<Response> {
  const session = await requireAccount(request, auth);
  const installation = await ownedInstallation(installationId, session.user.id, env);
  if (!installation) throw new HTTPError(404, "not_found");

  if (installation.revoked_at === null) await revokeInstallationRows(installationId, env);
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}

async function revokeInstallationRows(installationId: string, env: Env) {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("UPDATE installations SET revoked_at = ?, updated_at = ? WHERE id = ? AND revoked_at IS NULL")
      .bind(now, now, installationId),
    env.DB.prepare(
      "UPDATE installation_credentials SET revoked_at = ? WHERE installation_id = ? AND revoked_at IS NULL",
    ).bind(now, installationId),
  ]);
}

async function authenticateInstallation(request: Request, env: Env): Promise<InstallationCredentialRow | null> {
  const authorization = request.headers.get("authorization");
  const bearer = authorization?.match(/^Bearer\s+([^\s]+)$/i)?.[1];
  const parsed = bearer?.match(INSTALLATION_CREDENTIAL);
  if (!bearer || !parsed) return null;

  const row = await env.DB.prepare(
    `SELECT c.installation_id, c.lookup_id, c.secret_hash, c.expires_at,
            i.display_name, i.client_instance_id, i.platform, i.app_version,
            i.created_at, i.updated_at, i.last_seen_at
       FROM installation_credentials c
       JOIN installations i ON i.id = c.installation_id
      WHERE c.lookup_id = ?
        AND c.revoked_at IS NULL
        AND c.expires_at > ?
        AND i.revoked_at IS NULL`,
  ).bind(parsed[1], Date.now()).first<InstallationCredentialRow>();
  if (!row) return null;

  const expected = fromHex(row.secret_hash);
  if (!expected) return null;
  const actual = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bearer)));
  if (!timingSafeEqual(actual, expected)) return null;
  return row;
}

export async function requireInstallation(
  request: Request,
  env: Env,
): Promise<InstallationCredentialRow> {
  const installation = await authenticateInstallation(request, env);
  if (!installation) throw new HTTPError(401, "unauthorized");

  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE installation_credentials
          SET last_used_at = ?
        WHERE lookup_id = ? AND revoked_at IS NULL`,
    ).bind(now, installation.lookup_id),
    env.DB.prepare(
      `UPDATE installations
          SET last_seen_at = ?
        WHERE id = ? AND revoked_at IS NULL`,
    ).bind(now, installation.installation_id),
  ]);
  installation.last_seen_at = now;
  return installation;
}

export async function installationSelf(request: Request, env: Env): Promise<Response> {
  const installation = await requireInstallation(request, env);
  return json({
    installation: {
      id: installation.installation_id,
      clientInstanceId: installation.client_instance_id,
      name: installation.display_name,
      platform: installation.platform,
      appVersion: installation.app_version,
      createdAt: installation.created_at,
      updatedAt: installation.updated_at,
      lastSeenAt: installation.last_seen_at,
    },
    credentialExpiresAt: installation.expires_at,
  });
}

// ---------------------------------------------------------------------------
// Installation-owned registration: a desktop gets its hosted companion address
// with no email. It is trust on first use: the first caller for a computer
// receives a fresh owner and credential, and from then on possession of that
// credential is the only proof. A repeated registration never adopts or
// returns an existing installation (the client ID is not a secret), it makes
// a new one. Unauthenticated, so it is bounded per IP, globally, and in total.

export const INSTALLATION_OWNED_EMAIL_DOMAIN = "installations.bosbot.invalid";
const REGISTRATION_WINDOW_MS = 60 * 60 * 1_000;
const REGISTRATION_RETENTION_MS = 24 * 60 * 60 * 1_000;
export const REGISTRATION_PER_IP_MAX = 5;
export const REGISTRATION_GLOBAL_MAX = 100;
/** Active installation-owned computers, each of which may hold one tunnel on
 * BOS Bot's Cloudflare account. Raising it is a deliberate redeploy. */
export const INSTALLATION_OWNED_CAP = 500;

const registerInstallationSchema = createInstallationSchema;

async function registrationLimitKey(label: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`installation-registration:${label}`)));
}

/** One IPv6 subscriber usually holds a whole /64, so a per-address limit is
 * no limit at all there. IPv4 stays per address. */
export function registrationSource(header: string | null): string {
  const ip = header?.trim().toLowerCase() || "unknown";
  if (!ip.includes(":")) return ip;
  const [head, tail = ""] = ip.split("::", 2);
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = ip.includes("::")
    ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right]
    : left;
  return `${groups.slice(0, 4).map((group) => group.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

async function takeRegistrationAttempt(env: Env, key: string, max: number, now: number): Promise<boolean> {
  const cutoff = now - REGISTRATION_WINDOW_MS;
  const result = await env.DB.prepare(
    `INSERT INTO installation_registration_limits
      (limit_key, window_started_at, attempts, updated_at)
     VALUES (?, ?, 1, ?)
     ON CONFLICT(limit_key) DO UPDATE SET
       window_started_at = CASE
         WHEN window_started_at <= ? THEN excluded.window_started_at
         ELSE window_started_at
       END,
       attempts = CASE
         WHEN window_started_at <= ? THEN 1
         ELSE attempts + 1
       END,
       updated_at = excluded.updated_at
     WHERE window_started_at <= ? OR attempts < ?`,
  ).bind(key, now, now, cutoff, cutoff, cutoff, max).run();
  return result.meta.changes > 0;
}

async function installationOwned(installationId: string, env: Env): Promise<{ owner_user_id: string } | null> {
  return env.DB.prepare(
    `SELECT i.owner_user_id
       FROM installations i
       JOIN installation_owned_accounts o ON o.user_id = i.owner_user_id
      WHERE i.id = ? AND i.revoked_at IS NULL`,
  ).bind(installationId).first<{ owner_user_id: string }>();
}

export async function registerInstallation(request: Request, env: Env): Promise<Response> {
  const parsed = registerInstallationSchema.safeParse(await readBoundedJSON(request));
  if (!parsed.success) throw new HTTPError(400, "invalid_request");

  const now = Date.now();
  // Cloudflare writes cf-connecting-ip at the edge; a client cannot spoof it.
  const ip = registrationSource(request.headers.get("cf-connecting-ip"));
  const [ipKey, globalKey] = await Promise.all([
    registrationLimitKey(`ip:${ip}`, env.BETTER_AUTH_SECRET),
    registrationLimitKey("global", env.BETTER_AUTH_SECRET),
  ]);
  if (!(await takeRegistrationAttempt(env, ipKey, REGISTRATION_PER_IP_MAX, now))) {
    throw new HTTPError(429, "rate_limited");
  }
  if (!(await takeRegistrationAttempt(env, globalKey, REGISTRATION_GLOBAL_MAX, now))) {
    throw new HTTPError(429, "rate_limited");
  }
  await env.DB.prepare("DELETE FROM installation_registration_limits WHERE updated_at < ?")
    .bind(now - REGISTRATION_RETENTION_MS).run();

  const active = await env.DB.prepare(
    `SELECT COUNT(*) AS total
       FROM installations i
       JOIN installation_owned_accounts o ON o.user_id = i.owner_user_id
      WHERE i.revoked_at IS NULL`,
  ).first<{ total: number }>();
  if ((active?.total ?? 0) >= INSTALLATION_OWNED_CAP) {
    console.error(JSON.stringify({ message: "installation-owned registration cap reached" }));
    throw new HTTPError(503, "registration_closed");
  }

  const ownerUserId = crypto.randomUUID();
  const installationId = crypto.randomUUID();
  const credential = await newCredential(now);
  const stamp = new Date(now).toISOString();
  await env.DB.batch([
    // An owner row for this one computer. Its address is unroutable, it is
    // never verified, and OTP mail to its domain is refused, so it can never
    // sign in as a person or enroll anything that needs a verified human.
    env.DB.prepare(
      `INSERT INTO "user" (id, name, email, "emailVerified", image, "createdAt", "updatedAt")
       VALUES (?, 'BOS Bot computer', ?, 0, NULL, ?, ?)`,
    ).bind(ownerUserId, `${ownerUserId}@${INSTALLATION_OWNED_EMAIL_DOMAIN}`, stamp, stamp),
    env.DB.prepare("INSERT INTO installation_owned_accounts (user_id, created_at) VALUES (?, ?)")
      .bind(ownerUserId, now),
    env.DB.prepare(
      `INSERT INTO installations
        (id, owner_user_id, client_instance_id, display_name, platform, app_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      installationId,
      ownerUserId,
      parsed.data.clientInstanceId,
      parsed.data.name,
      parsed.data.platform,
      parsed.data.appVersion ?? null,
      now,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO installation_credentials
        (id, installation_id, lookup_id, secret_hash, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(crypto.randomUUID(), installationId, credential.lookupId, credential.secretHash, now, credential.expiresAt),
  ]);

  return json({
    installation: {
      id: installationId,
      clientInstanceId: parsed.data.clientInstanceId,
      name: parsed.data.name,
      platform: parsed.data.platform,
      appVersion: parsed.data.appVersion ?? null,
      createdAt: now,
      updatedAt: now,
      lastSeenAt: null,
    },
    credential: credential.raw,
    credentialExpiresAt: credential.expiresAt,
  }, 201);
}

/** An installation-owned computer whose credential lapsed can never prove
 * itself again, so it is revoked: that frees its place under the cap and lets
 * the endpoint sweep delete its tunnel. Account-owned installations are left
 * to their owner. */
export async function reapLapsedInstallationOwned(env: Env, now = Date.now()): Promise<number> {
  const result = await env.DB.prepare(
    `UPDATE installations
        SET revoked_at = ?, updated_at = ?
      WHERE revoked_at IS NULL
        AND owner_user_id IN (SELECT user_id FROM installation_owned_accounts)
        AND NOT EXISTS (
          SELECT 1 FROM installation_credentials c
           WHERE c.installation_id = installations.id
             AND c.revoked_at IS NULL
             AND c.expires_at > ?
        )`,
  ).bind(now, now, now).run();
  return result.meta.changes;
}

/** Installation-owned computers have no account bearer to rotate with, so the
 * current credential renews itself before it expires. */
export async function rotateSelfCredential(request: Request, env: Env): Promise<Response> {
  const installation = await requireInstallation(request, env);
  const owned = await installationOwned(installation.installation_id, env);
  if (!owned) throw new HTTPError(403, "forbidden");
  return rotateCredentialRows(installation.installation_id, env, owned.owner_user_id);
}

/** Sign-out for an installation-owned computer. Returns the revoked ID so the
 * caller can schedule endpoint cleanup, exactly like an owner revocation. */
export async function revokeSelf(request: Request, env: Env): Promise<string> {
  const installation = await requireInstallation(request, env);
  const owned = await installationOwned(installation.installation_id, env);
  if (!owned) throw new HTTPError(403, "forbidden");
  await revokeInstallationRows(installation.installation_id, env);
  return installation.installation_id;
}
