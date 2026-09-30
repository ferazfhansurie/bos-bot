import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { enrollmentPermitSQL } from "./remote-full-enrollment-permit.mjs";
const scope = { environmentId: "00000000-0000-4000-8000-000000000001", installationId: "00000000-0000-4000-8000-000000000002", ownerUserId: "owner", serverKey: "a".repeat(43), audience: "https://fixture.invalid" };
function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE user (id TEXT, email TEXT, emailVerified INTEGER);
    CREATE TABLE installations (id TEXT, owner_user_id TEXT, revoked_at INTEGER);
    CREATE TABLE remote_full_bindings (environment_id TEXT, installation_id TEXT, owner_user_id TEXT, server_key TEXT, audience TEXT);
    CREATE TABLE remote_full_enrollment_permits (environment_id TEXT PRIMARY KEY, installation_id TEXT UNIQUE, owner_user_id TEXT, server_key TEXT, audience TEXT, expires_at INTEGER);`);
  db.prepare("INSERT INTO user VALUES (?, ?, 1)").run("owner", "owner@example.invalid");
  db.prepare("INSERT INTO installations VALUES (?, ?, NULL)").run(scope.installationId, "owner");
  return db;
}
test("reviewed permit SQL reserves once and cannot overwrite a reservation", () => {
  const db = fixture(); try {
    const sql = enrollmentPermitSQL(scope, "owner@example.invalid", 1000); db.exec(sql);
    assert.equal(db.prepare("SELECT expires_at FROM remote_full_enrollment_permits").get().expires_at, 1801000);
    assert.throws(() => db.exec(sql), /UNIQUE/);
  } finally { db.close(); }
});
for (const kind of ["email", "unverified", "revoked", "conflicting-binding"]) test(`operator SQL refuses ${kind}`, () => {
  const db = fixture(); try {
    if (kind === "unverified") db.exec("UPDATE user SET emailVerified = 0");
    if (kind === "revoked") db.exec("UPDATE installations SET revoked_at = 1");
    if (kind === "conflicting-binding") db.prepare("INSERT INTO remote_full_bindings VALUES (?, ?, ?, ?, ?)").run(scope.environmentId, "other", "other", scope.serverKey, scope.audience);
    db.exec(enrollmentPermitSQL(scope, kind === "email" ? "wrong@example.invalid" : "owner@example.invalid"));
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM remote_full_enrollment_permits").get().n, 0);
  } finally { db.close(); }
});
test("scope is strict and cannot contain credentials or injected SQL", () => {
  assert.throws(() => enrollmentPermitSQL({ ...scope, credential: "secret" }, "owner@example.invalid"));
  assert.throws(() => enrollmentPermitSQL({ ...scope, environmentId: "'; DROP TABLE user;--" }, "owner@example.invalid"));
});
