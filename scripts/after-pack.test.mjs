import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import afterPack, { packagedSourceCommit, stampBuildCommit } from "./after-pack.mjs";
import { LICENSE_FILES } from "./cua-linux-release.mjs";

const temporaryDirectories = [];

function fixture() {
  const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), "omb-after-pack-"));
  temporaryDirectories.push(appOutDir);
  const resources = path.join(appOutDir, "resources");
  const cua = path.join(resources, "cua-linux-x64");
  const licenses = path.join(cua, "licenses");
  fs.mkdirSync(licenses, { recursive: true, mode: 0o775 });
  for (const directory of [appOutDir, resources, cua, licenses]) fs.chmodSync(directory, 0o775);
  for (const name of ["cua-driver", "cua-cursor-theme", "release.json"]) {
    fs.writeFileSync(path.join(cua, name), "fixture", { mode: 0o664 });
    fs.chmodSync(path.join(cua, name), 0o664);
  }
  for (const name of LICENSE_FILES) {
    fs.writeFileSync(path.join(licenses, name), "fixture", { mode: 0o664 });
    fs.chmodSync(path.join(licenses, name), 0o664);
  }
  return { appOutDir, resources, cua, licenses };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform === "win32")("Linux afterPack permissions", () => {
  it("repairs every packaged CUA ancestor and resource mode", async () => {
    const { appOutDir, resources, cua, licenses } = fixture();

    await afterPack({ electronPlatformName: "linux", appOutDir });

    for (const directory of [appOutDir, resources, cua, licenses]) {
      expect(fs.lstatSync(directory).mode & 0o777).toBe(0o755);
    }
    for (const name of ["cua-driver", "cua-cursor-theme"]) {
      expect(fs.lstatSync(path.join(cua, name)).mode & 0o777).toBe(0o755);
    }
    expect(fs.lstatSync(path.join(cua, "release.json")).mode & 0o777).toBe(0o644);
    for (const name of fs.readdirSync(licenses)) {
      expect(fs.lstatSync(path.join(licenses, name)).mode & 0o777).toBe(0o644);
    }
  });

  it("fails closed when the runtime root is replaced by a symlink", async () => {
    const { appOutDir, cua } = fixture();
    const replacement = path.join(appOutDir, "replacement");
    fs.mkdirSync(replacement);
    fs.rmSync(cua, { recursive: true });
    fs.symlinkSync(replacement, cua, "dir");
    await expect(afterPack({ electronPlatformName: "linux", appOutDir })).rejects.toThrow(
      "must be a real directory",
    );
  });

  it("fails closed when the release manifest is missing", async () => {
    const { appOutDir, cua } = fixture();
    fs.unlinkSync(path.join(cua, "release.json"));
    await expect(afterPack({ electronPlatformName: "linux", appOutDir })).rejects.toThrow();
  });

  it("leaves non-Linux package modes unchanged", async () => {
    const { appOutDir, cua } = fixture();
    await afterPack({ electronPlatformName: "darwin", appOutDir });
    expect(fs.lstatSync(cua).mode & 0o777).toBe(0o775);
    expect(fs.lstatSync(path.join(cua, "cua-driver")).mode & 0o777).toBe(0o664);
  });
});

describe("desktop browser package gate", () => {
  it("rejects a missing browser manifest instead of accepting partial resources", async () => {
    const { appOutDir, resources } = fixture();
    fs.mkdirSync(path.join(resources, "browser-engine"));
    await expect(afterPack({ electronPlatformName: "win32", arch: 1, appOutDir }))
      .rejects.toThrow(/manifest\.json/);
  });

  it("rejects an unsupported package architecture before accepting the browser", async () => {
    const { appOutDir, resources } = fixture();
    fs.mkdirSync(path.join(resources, "browser-engine"));
    await expect(afterPack({ electronPlatformName: "win32", arch: 0, appOutDir }))
      .rejects.toThrow(/Unsupported desktop browser package architecture/);
  });
});

describe("build commit stamp", () => {
  const sha = "a".repeat(40);
  function trees(resources) {
    for (const [tree, file, body] of [["server", "index.js", "// server"], ["server", "nested/a.js", "// a"], ["server", "nested-x.js", "// x"], ["ui", "index.html", "<html/>"]]) {
      fs.mkdirSync(path.dirname(path.join(resources, tree, file)), { recursive: true });
      fs.writeFileSync(path.join(resources, tree, file), body);
    }
  }

  it("writes Resources/build-commit.json with the commit and the tree digests the python guard computes", async () => {
    const { resources } = fixture();
    trees(resources);
    const stamp = await stampBuildCommit(resources, sha);
    const written = JSON.parse(fs.readFileSync(path.join(resources, "build-commit.json"), "utf8"));
    expect(written).toEqual(stamp);
    expect(written.commit).toBe(sha);
    expect(written.server_sha256).toMatch(/^[0-9a-f]{64}$/);
    // the shipped guard must read this stamp as valid for these exact trees
    const app = path.join(resources, "..", "Stamped.app");
    fs.mkdirSync(path.join(app, "Contents"), { recursive: true });
    fs.renameSync(resources, path.join(app, "Contents", "Resources"));
    const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "electron", "resources", "updater", "no-downgrade.py");
    const probe = spawnSync("/usr/bin/python3", ["-c", `
import importlib.util, json, sys
from pathlib import Path
spec = importlib.util.spec_from_loader("g", loader=None); g = importlib.util.module_from_spec(spec)
exec(open(sys.argv[1]).read(), g.__dict__)
print(json.dumps(g.read_stamp(Path(sys.argv[2]))))`, script, app], { encoding: "utf8" });
    expect(probe.status, probe.stderr).toBe(0);
    expect(JSON.parse(probe.stdout)).toEqual([sha, "stamped"]);
  });

  it("refuses to stamp without a full source commit, and a real package without bosSourceCommit fails instead of shipping unstamped", async () => {
    const { appOutDir, resources } = fixture();
    trees(resources);
    await expect(stampBuildCommit(resources, "abc123")).rejects.toThrow(/full 40-hex source commit/);
    await expect(stampBuildCommit(resources, undefined)).rejects.toThrow(/got null/);
    expect(fs.existsSync(path.join(resources, "build-commit.json"))).toBe(false);
    expect(packagedSourceCommit({ packager: { metadata: { bosSourceCommit: sha } } })).toBe(sha);
    expect(packagedSourceCommit({ packager: { metadata: {}, config: { extraMetadata: { bosSourceCommit: sha } } } })).toBe(sha);
    expect(packagedSourceCommit({})).toBeNull();
    // fixtures without a packager and without a commit stay unstamped (the older hooks' tests)
    await afterPack({ electronPlatformName: "win32", arch: 1, appOutDir });
    expect(fs.existsSync(path.join(resources, "build-commit.json"))).toBe(false);
  });
});
