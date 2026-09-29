import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TurnResources, workspaceResource } from "./turn-resources.ts";

const a = { threadId: "a", generation: "1" };
const b = { threadId: "b", generation: "2" };

describe("thread resource ownership", () => {
  it("allows independent resources but holds the same screen across calls", () => {
    const leases = new TurnResources();
    expect(leases.claim("computer:host", a)).toBe(true);
    expect(leases.claim("computer:host", a)).toBe(true);
    expect(leases.claim("computer:host", b)).toBe(false);
    expect(leases.blocker("computer:host", b)).toEqual(a);
    expect(leases.blocker("computer:host", a)).toBeUndefined();
    expect(leases.claim("browser:other", b)).toBe(true);
    leases.release(a);
    expect(leases.blocker("computer:host", b)).toBeUndefined();
    expect(leases.claim("computer:host", b)).toBe(true);
    leases.release(a);
    expect(leases.owns("computer:host", b)).toBe(true);
  });

  it("does not release a replacement generation", () => {
    const leases = new TurnResources();
    const next = { ...a, generation: "next" };
    expect(leases.claim("browser:one", a)).toBe(true);
    expect(leases.claim("browser:one", next)).toBe(false);
    leases.release(a);
    expect(leases.claim("browser:one", next)).toBe(true);
    leases.release(a);
    expect(leases.owns("browser:one", next)).toBe(true);
  });

  it("releases one resource early without dropping the owner's others", () => {
    const leases = new TurnResources();
    expect(leases.claim("computer:vm:shared", a)).toBe(true);
    expect(leases.claim("browser:one", a)).toBe(true);
    leases.releaseOne("computer:vm:shared", a);
    expect(leases.owns("computer:vm:shared", a)).toBe(false);
    expect(leases.claim("computer:vm:shared", b)).toBe(true);
    expect(leases.owns("browser:one", a)).toBe(true);
    // Only the exact owner may drop it: a stale generation is a no-op.
    leases.releaseOne("computer:vm:shared", { ...b, generation: "stale" });
    expect(leases.owns("computer:vm:shared", b)).toBe(true);
  });

  it("prevents parent/child project overlap and symlink aliases, not sibling folders", () => {
    const root = mkdtempSync(join(tmpdir(), "omb-thread-resources-"));
    try {
      mkdirSync(join(root, "project", "nested"), { recursive: true });
      mkdirSync(join(root, "project-other"));
      symlinkSync(join(root, "project"), join(root, "alias"), process.platform === "win32" ? "junction" : "dir");
      const leases = new TurnResources();
      expect(leases.claim(workspaceResource(join(root, "project")), a)).toBe(true);
      expect(leases.claim(workspaceResource(join(root, "alias")), b)).toBe(false);
      expect(leases.claim(workspaceResource(join(root, "project", "nested")), b)).toBe(false);
      expect(leases.claim(workspaceResource(root), b)).toBe(false);
      expect(leases.claim(workspaceResource(join(root, "project-other")), b)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("treats differently cased paths as one workspace on case-insensitive volumes", ({ skip }) => {
    const root = mkdtempSync(join(tmpdir(), "omb-thread-case-"));
    try {
      const folder = join(root, "Project");
      const alias = join(root, "project");
      mkdirSync(folder);
      if (!existsSync(alias)) return skip();
      expect(workspaceResource(alias)).toBe(workspaceResource(folder));
      const leases = new TurnResources();
      expect(leases.claim(workspaceResource(folder), a)).toBe(true);
      expect(leases.claim(workspaceResource(alias), b)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});


describe("shared workspace writers and exclusive restore", () => {
  it("tracks every parallel writer and excludes restore until all settle", () => {
    const leases = new TurnResources();
    const resource = "workspace:/fixture/project";
    const restore = { threadId: "restore", generation: "restore-1" };
    expect(leases.claim(resource, a, { shared: true })).toBe(true);
    expect(leases.claim(resource, b, { shared: true })).toBe(true);
    expect(leases.claim(resource, restore)).toBe(false);
    leases.release(a);
    expect(leases.claim(resource, restore)).toBe(false);
    leases.release(b);
    expect(leases.claim(resource, restore)).toBe(true);
    expect(leases.claim(resource, a, { shared: true })).toBe(false);
    expect(leases.claim(`${resource}/nested`, b, { shared: true })).toBe(false);
    leases.release(restore);
    expect(leases.claim(resource, a, { shared: true })).toBe(true);
  });
});

it("keeps parallel canonical/nested leases generation-scoped and cannot downgrade an exclusive owner", () => {
  const root = mkdtempSync(join(tmpdir(), "omb-shared-leases-"));
  try {
    mkdirSync(join(root, "project", "nested"), { recursive: true });
    symlinkSync(join(root, "project"), join(root, "alias"), process.platform === "win32" ? "junction" : "dir");
    const leases = new TurnResources();
    const parent = workspaceResource(join(root, "project"));
    const alias = workspaceResource(join(root, "alias"));
    const nested = workspaceResource(join(root, "project", "nested"));
    const restore = { threadId: "restore", generation: "1" };
    expect(leases.claim(alias, a, { shared: true })).toBe(true);
    expect(leases.claim(nested, b, { shared: true })).toBe(true);
    leases.release({ ...a, generation: "obsolete" });
    expect(leases.owns(parent, a)).toBe(true);
    expect(leases.claim(parent, restore)).toBe(false);
    leases.release(a);
    expect(leases.claim(parent, restore)).toBe(false);
    leases.release(b);
    expect(leases.claim(parent, restore)).toBe(true);
    expect(leases.claim(parent, restore, { shared: true })).toBe(true);
    expect(leases.claim(alias, a, { shared: true })).toBe(false);
    leases.release({ ...restore, generation: "stale" });
    expect(leases.claim(nested, b, { shared: true })).toBe(false);
    leases.release(restore);
    expect(leases.claim(nested, b, { shared: true })).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
