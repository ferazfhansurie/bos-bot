import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { stampBuildCommit } from "./after-pack.mjs";
import { appDigests } from "../server/updater.ts";

const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve("electron-builder"));
const { sign } = builderRequire("app-builder-lib/out/codeSign/macCodeSign.js");
const { resolveFunction } = builderRequire("app-builder-lib/out/util/resolve.js");
const directories = [];
const commit = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
const config = parse(fs.readFileSync(new URL("../electron-builder.yml", import.meta.url), "utf8"));

afterEach(() => {
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

it("refuses a missing or abbreviated source commit before signing", async () => {
  const hook = await resolveFunction("module", config.mac.sign, "sign", process.cwd());
  for (const bosSourceCommit of [undefined, "abc123"]) {
    await expect(hook({ app: "/does-not-exist.app" }, { metadata: { bosSourceCommit } }))
      .rejects.toThrow("full 40-hex source commit");
  }
});

describe.skipIf(process.platform !== "darwin")("mac build stamp signing", () => {
  it("seals a stamp for the final signed native bytes and rejects later tampering", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bos-sign-stamp-"));
    directories.push(dir);
    const app = path.join(dir, "Fixture.app");
    const contents = path.join(app, "Contents");
    const resources = path.join(contents, "Resources");
    const executable = path.join(contents, "MacOS", "fixture");
    const native = path.join(resources, "server", "vendor", "spawn-helper");
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.mkdirSync(path.dirname(native), { recursive: true });
    fs.mkdirSync(path.join(resources, "ui"));
    fs.writeFileSync(path.join(resources, "ui", "index.html"), "<html/>");
    fs.writeFileSync(path.join(contents, "Info.plist"), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>fixture</string><key>CFBundleIdentifier</key><string>ai.bos.stamp.fixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`);
    const compiled = spawnSync("/usr/bin/clang", ["-x", "c", "-o", executable, "-"], { input: "int main(void) { return 0; }", encoding: "utf8" });
    expect(compiled.status, compiled.stderr).toBe(0);
    fs.copyFileSync(executable, native);
    const unsigned = await stampBuildCommit(resources, commit);
    const entitlements = path.join(dir, "entitlements.plist");
    fs.writeFileSync(entitlements, `<?xml version="1.0"?><plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>`);
    const visited = [];
    const options = {
      app, platform: "darwin", identity: "-", identityValidation: false,
      preAutoEntitlements: false, preEmbedProvisioningProfile: false,
      optionsForFile: (file) => {
        visited.push(file);
        return { entitlements, hardenedRuntime: true, timestamp: "none" };
      },
    };
    // Exercise the configured hook, or the builder's default before the fix.
    const hook = config.mac.sign
      ? await resolveFunction("module", config.mac.sign, "sign", process.cwd())
      : sign;
    await hook(options, { metadata: { bosSourceCommit: commit }, projectDir: process.cwd() });
    expect(visited.at(-1)).toBe(app);
    expect(visited).toContain(native);
    const actual = appDigests(app);
    expect(actual.server).not.toBe(unsigned.server_sha256);
    const stamp = JSON.parse(fs.readFileSync(path.join(resources, "build-commit.json"), "utf8"));
    expect(stamp).toMatchObject({ commit, server_sha256: actual.server, ui_sha256: actual.ui });
    const verify = () => spawnSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], { encoding: "utf8" });
    expect(verify().status).toBe(0);
    const guard = path.resolve("electron/resources/updater/no-downgrade.py");
    const readStamp = () => {
      const result = spawnSync("/usr/bin/python3", ["-c", "import sys,json; from pathlib import Path; g={'__name__':'fixture'}; exec(open(sys.argv[1]).read(),g); print(json.dumps(g['read_stamp'](Path(sys.argv[2]))))", guard, app], { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      return JSON.parse(result.stdout);
    };
    expect(readStamp()).toEqual([commit, "stamped"]);
    fs.appendFileSync(path.join(resources, "ui", "index.html"), "tampered");
    expect(readStamp()).toEqual([null, expect.stringContaining("changed after stamping")]);
    expect(verify().status).not.toBe(0);
  }, 30_000);
});
