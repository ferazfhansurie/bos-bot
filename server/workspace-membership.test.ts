import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as atomic from "./atomic.ts";
import { rebaseWorkspaceMembershipLedger, WorkspaceMembership } from "./workspace-membership.ts";
import type { WorkspaceRole } from "../shared/workspace-membership.ts";

const owner = "home:person:owner", foreignOwner = "other:person:owner", member = "home:person:member";
describe("workspace membership authority", () => {
  let dir: string, file: string, ledger: WorkspaceMembership;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omb-membership-"));
    file = join(dir, "membership.json");
    ledger = new WorkspaceMembership(file, owner);
  });
  afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });
  it("keeps the configured owner immutable and grants no authority from actor home", () => {
    expect(ledger.list()).toEqual([{ actorId: owner, role: "owner" }]);
    expect(ledger.canManage(owner)).toBe(true);
    for (const actor of [member, foreignOwner]) {
      expect(ledger.role(actor)).toBe("client-guest");
      expect(ledger.canManage(actor)).toBe(false);
    }
    expect(() => ledger.set(owner, "member")).toThrow();
    expect(() => ledger.remove(owner)).toThrow();
    expect(() => ledger.set(foreignOwner, "owner" as Exclude<WorkspaceRole, "owner">)).toThrow();
    ledger.set(foreignOwner, "admin");
    expect(ledger.canManage(foreignOwner)).toBe(true);
    ledger.set(foreignOwner, "member");
    expect(ledger.canManage(foreignOwner)).toBe(false);
    ledger.remove(foreignOwner);
    expect(ledger.role(foreignOwner)).toBe("client-guest");
  });
  it("persists roles and room-specific grants with private permissions", () => {
    ledger.set(member, "member");
    ledger.set(foreignOwner, "client-guest");
    ledger.setGrants("room-a", ["home:bot:api", "other:bot:ui"]);
    const restored = new WorkspaceMembership(file, owner);
    expect(restored.list()).toEqual(ledger.list());
    expect(restored.grants("room-a")).toEqual(["home:bot:api", "other:bot:ui"]);
    expect(restored.grants("room-b")).toEqual([]);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600); // Windows has no POSIX modes
    const view = restored.list(); view[1]!.role = "admin";
    const grants = restored.grants("room-a"); grants.push("bad");
    expect(restored.role(member)).toBe("member");
    expect(restored.grants("room-a")).toHaveLength(2);
    restored.setGrants("room-a", []);
    expect(new WorkspaceMembership(file, owner).grants("room-a")).toEqual([]);
    expect(() => new WorkspaceMembership(file, foreignOwner)).toThrow();
  });
  it("rejects malformed ids, kinds, roles and duplicate grants", () => {
    for (const actor of ["bad", "home:bot:api", "home:person:owner:extra"]) {
      expect(() => ledger.role(actor)).toThrow();
      expect(() => ledger.set(actor, "member")).toThrow();
      expect(() => ledger.remove(actor)).toThrow();
    }
    expect(() => ledger.set(member, "bogus" as "member")).toThrow();
    for (const botIds of [[member], ["api"], ["home:bot:api", "home:bot:api"]]) {
      expect(() => ledger.setGrants("room-a", botIds)).toThrow();
    }
    expect(() => ledger.setGrants("../room", [])).toThrow();
    expect(() => new WorkspaceMembership(file, "home:bot:owner")).toThrow();
  });
  it("fails closed on corruption during construction, reads and mutations", () => {
    ledger.set(member, "admin");
    const valid = JSON.parse(readFileSync(file, "utf8"));
    const corruptions = ["{", "null", JSON.stringify({ ...valid, version: 2 }),
      JSON.stringify({ ...valid, members: [{ actorId: foreignOwner, role: "owner" }] }),
      JSON.stringify({ ...valid, members: [valid.members[0], valid.members[0]] }),
      JSON.stringify({ ...valid, roomBotGrants: [{ roomId: "r", botIds: [member] }] })];
    for (const corrupt of corruptions) {
      writeFileSync(file, corrupt);
      for (const read of [() => ledger.role(owner), () => ledger.list(), () => ledger.grants("r"), () => ledger.canManage(member)]) expect(read).toThrow();
      for (const mutate of [() => ledger.set(member, "member"), () => ledger.remove(member), () => ledger.setGrants("r", [])]) expect(mutate).toThrow();
      expect(() => new WorkspaceMembership(file, owner)).toThrow();
      expect(readFileSync(file, "utf8")).toBe(corrupt);
    }
  });
  it("preserves all authority when durable writes fail", () => {
    ledger.set(member, "admin"); ledger.setGrants("r", ["home:bot:api"]);
    const before = readFileSync(file, "utf8");
    vi.spyOn(atomic, "writeFileAtomic").mockImplementation(() => { throw new Error("disk full"); });
    for (const mutate of [() => ledger.set(member, "member"), () => ledger.remove(member), () => ledger.set(foreignOwner, "admin"), () => ledger.setGrants("r", [])]) expect(mutate).toThrow("disk full");
    expect(ledger.role(member)).toBe("admin");
    expect(ledger.role(foreignOwner)).toBe("client-guest");
    expect(ledger.grants("r")).toEqual(["home:bot:api"]);
    expect(readFileSync(file, "utf8")).toBe(before);
  });
});

it("migrates only existing bound identities once and leaves later bindings guest", () => {
  const folder = mkdtempSync(join(tmpdir(), "membership-upgrade-"));
  try {
    const file = join(folder, "membership.json");
    const first = new WorkspaceMembership(file, "home:person:owner", ["home:person:owner", "old:person:owner"]);
    expect(first.role("old:person:owner")).toBe("member");
    const second = new WorkspaceMembership(file, "home:person:owner", ["new:person:owner"]);
    expect(second.role("old:person:owner")).toBe("member");
    expect(second.role("new:person:owner")).toBe("client-guest");
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

describe("restoring a membership ledger onto another home", () => {
  let folder: string, file: string;
  const source = "src:person:owner", destination = "dst:person:owner";
  beforeEach(() => { folder = mkdtempSync(join(tmpdir(), "membership-rebase-")); file = join(folder, "membership.json"); });
  afterEach(() => { vi.restoreAllMocks(); rmSync(folder, { recursive: true, force: true }); });

  it("rebases to the destination owner without carrying source-home authority", () => {
    const ledger = new WorkspaceMembership(file, source);
    ledger.set("src:person:alice", "admin");
    ledger.set(destination, "admin");
    ledger.set("dst:person:bob", "member");
    ledger.set("other:person:owner", "admin");
    ledger.set("third:person:carol", "client-guest");
    ledger.setGrants("room-a", ["src:bot:helper", "other:bot:ui"]);
    ledger.setGrants("room-b", ["src:bot:helper"]);
    rebaseWorkspaceMembershipLedger(file, destination);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600); // Windows has no POSIX modes
    expect(() => new WorkspaceMembership(file, source)).toThrow("invalid workspace membership ledger");
    const restored = new WorkspaceMembership(file, destination);
    expect(restored.list()).toEqual([
      { actorId: destination, role: "owner" },
      { actorId: "dst:person:bob", role: "member" },
      { actorId: "other:person:owner", role: "admin" },
      { actorId: "third:person:carol", role: "client-guest" },
    ]);
    // Neither the source owner nor another source-home admin gains anything.
    for (const actor of [source, "src:person:alice"]) {
      expect(restored.role(actor)).toBe("client-guest");
      expect(restored.canManage(actor)).toBe(false);
    }
    expect(restored.grants("room-a")).toEqual(["other:bot:ui"]);
    expect(restored.grants("room-b")).toEqual([]);
    // A legacy upgrade must not run later over the restored actor bindings.
    expect(new WorkspaceMembership(file, destination, ["src:person:alice"]).role("src:person:alice")).toBe("client-guest");
  });

  it("leaves same-home ledgers byte-identical and missing ledgers missing", () => {
    rebaseWorkspaceMembershipLedger(file, destination);
    expect(() => readFileSync(file)).toThrow();
    const ledger = new WorkspaceMembership(file, destination);
    ledger.set("src:person:alice", "admin");
    ledger.setGrants("room-a", ["dst:bot:helper"]);
    const before = readFileSync(file, "utf8");
    rebaseWorkspaceMembershipLedger(file, destination);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("refuses corrupt or non-owner source ledgers instead of rebasing them", () => {
    new WorkspaceMembership(file, source).set("src:person:alice", "member");
    const valid = JSON.parse(readFileSync(file, "utf8"));
    const corruptions = ["{", "null", JSON.stringify({ ...valid, version: 2 }), JSON.stringify({ ...valid, ownerId: "src:person:alice" }),
      JSON.stringify({ ...valid, ownerId: "src:bot:owner" }), JSON.stringify({ ...valid, members: [{ actorId: "other:person:owner", role: "owner" }] }),
      JSON.stringify({ ...valid, members: [{ actorId: source, role: "admin" }] }),
      JSON.stringify({ ...valid, roomBotGrants: [{ roomId: "r", botIds: ["other:person:owner"] }] })];
    for (const corrupt of corruptions) {
      writeFileSync(file, corrupt);
      expect(() => rebaseWorkspaceMembershipLedger(file, destination)).toThrow();
      expect(readFileSync(file, "utf8")).toBe(corrupt);
    }
    writeFileSync(file, JSON.stringify(valid));
    expect(() => rebaseWorkspaceMembershipLedger(file, "dst:bot:owner")).toThrow();
    expect(readFileSync(file, "utf8")).toBe(JSON.stringify(valid));
  });
});
