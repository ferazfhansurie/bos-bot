#!/usr/bin/env node
// Offline SQL preparation ONLY. No credentials, network or D1 writes. A CP
// operator must independently verify the human server owner and this scope,
// review the generated statement, then apply via their existing admin process.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { z } from "zod";
export function enrollmentPermitSQL(rawScope, verifiedOwnerEmail, now = Date.now()) {
  const scope = z.object({ environmentId: z.string().uuid(), installationId: z.string().uuid(), ownerUserId: z.string().min(1).max(256),
    serverKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/), audience: z.string().url().refine(value => new URL(value).origin === value && value.startsWith("https://")) }).strict().parse(rawScope);
  const email = z.string().email().parse(verifiedOwnerEmail).toLowerCase();
  const sql = value => `'${String(value).replaceAll("'", "''")}'`;
  return `-- public enrollment scope only; reviewed reservation expires in 30 minutes.
-- expect exactly one inserted row; zero rows or a uniqueness error means STOP.
INSERT INTO remote_full_enrollment_permits (environment_id, installation_id, owner_user_id, server_key, audience, expires_at)
SELECT ${sql(scope.environmentId)}, ${sql(scope.installationId)}, ${sql(scope.ownerUserId)}, ${sql(scope.serverKey)}, ${sql(scope.audience)}, ${now + 30 * 60_000}
WHERE EXISTS (SELECT 1 FROM installations i JOIN "user" u ON u.id = i.owner_user_id WHERE i.id = ${sql(scope.installationId)} AND i.owner_user_id = ${sql(scope.ownerUserId)} AND i.revoked_at IS NULL AND lower(u.email) = ${sql(email)} AND u.emailVerified = 1)
AND NOT EXISTS (SELECT 1 FROM remote_full_bindings b WHERE (b.environment_id = ${sql(scope.environmentId)} OR b.installation_id = ${sql(scope.installationId)}) AND (b.environment_id <> ${sql(scope.environmentId)} OR b.installation_id <> ${sql(scope.installationId)} OR b.owner_user_id <> ${sql(scope.ownerUserId)} OR b.server_key <> ${sql(scope.serverKey)} OR b.audience <> ${sql(scope.audience)}));\n`;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [path, email] = process.argv.slice(2);
  if (!path || !email || process.argv.length !== 4) throw new Error("Usage: node scripts/remote-full-enrollment-permit.mjs <public-scope.json> <independently-verified-owner-email> (prints SQL only)");
  process.stdout.write(enrollmentPermitSQL(JSON.parse(readFileSync(path, "utf8")), email));
}
