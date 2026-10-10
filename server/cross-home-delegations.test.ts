import { afterEach, expect, test } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Delegations, migrateLegacyGrants } from "./cross-home-delegations.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
test("delegation checks the exact peer session, home, bot and scope on every call", () => {
  const dir = mkdtempSync(join(tmpdir(), "delegations-")); dirs.push(dir);
  const file = join(dir, "delegations.json");
  const grants = new Delegations(file, () => 1000, () => {});
  const identity = { sessionId: "peer-session", tokenHash: "a".repeat(64), homeId: "firaz", botId: "jarvis" };
  expect(() => grants.require(identity, "coordinate")).toThrow();
  const entry = { granteeHomeId: "firaz", granteeBotId: "jarvis", peerSessionId: "peer-session", peerTokenHash: "a".repeat(64), scopes: ["coordinate", "bots:create"], section: "", note: "fixture", expiresAt: 2000 };
  writeFileSync(file, JSON.stringify({ version: 1, delegations: [entry] }));
  expect(grants.require(identity, "coordinate").section).toBe("");
  for (const patch of [{ sessionId: "wrong" }, { tokenHash: "b".repeat(64) }, { homeId: "wrong" }, { botId: "wrong" }]) expect(() => grants.require({ ...identity, ...patch }, "coordinate")).toThrow();
  expect(() => grants.require(identity, "bots:delete")).toThrow();
  writeFileSync(file, JSON.stringify({ version: 1, delegations: [{ ...entry, expiresAt: 1000 }] }));
  expect(() => grants.require(identity, "coordinate")).toThrow();
  writeFileSync(file, JSON.stringify({ version: 1, delegations: [] }));
  expect(() => grants.require(identity, "coordinate")).toThrow();
  writeFileSync(file, "malformed");
  expect(() => grants.require(identity, "coordinate")).toThrow();
});
test("a malformed entry invalidates the entire file", () => {
  const dir = mkdtempSync(join(tmpdir(), "delegations-")); dirs.push(dir);
  const file = join(dir, "delegations.json");
  writeFileSync(file, JSON.stringify({ version: 1, delegations: [{ scopes: ["admin"] }] }));
  expect(() => new Delegations(file).require({ sessionId: "x", tokenHash: "a".repeat(64), homeId: "x", botId: "x" }, "coordinate")).toThrow();
});
test("grant-shaped legacy delegations.json moves to its own file once; queue maps stay put", () => {
  const dir = mkdtempSync(join(tmpdir(), "delegations-")); dirs.push(dir);
  const legacy = join(dir, "delegations.json"), file = join(dir, "cross-home-grants.json");
  writeFileSync(legacy, "{}");
  migrateLegacyGrants(legacy, file);
  expect(existsSync(file)).toBe(false);
  const entry = { granteeHomeId: "firaz", granteeBotId: "jarvis", peerSessionId: "peer-session", peerTokenHash: "a".repeat(64), scopes: ["coordinate"], section: "", note: "fixture" };
  writeFileSync(legacy, JSON.stringify({ version: 1, delegations: [entry] }));
  migrateLegacyGrants(legacy, file);
  expect(new Delegations(file).require({ sessionId: "peer-session", tokenHash: "a".repeat(64), homeId: "firaz", botId: "jarvis" }, "coordinate").note).toBe("fixture");
  writeFileSync(legacy, "{}"); // the queue rewrites its own file; the grant survives
  migrateLegacyGrants(legacy, file);
  expect(JSON.parse(readFileSync(file, "utf8")).delegations).toHaveLength(1);
});
