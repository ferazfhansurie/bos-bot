// A tree update may retain native resources only from a known complete package.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

export const NATIVE_CONTRACT_FILE = "native-contract.json";
const swapped = new Set(["server", "ui", "updater", "build-commit.json", NATIVE_CONTRACT_FILE]);
const fail = (reason) => { throw new Error(`Native compatibility unknown or incompatible (${reason}); install a full desktop package instead.`); };

// Everything copied from a complete shell, including app.asar, companion,
// browser/CUA/phone helpers and skills. Symlinks are hashed, never followed.
export function nativeResourceDigest(resources) {
  const hash = createHash("sha256");
  function walk(dir) {
    for (const name of readdirSync(dir).sort()) {
      if (dir === resources && swapped.has(name)) continue;
      const file = join(dir, name); const stat = lstatSync(file);
      hash.update(JSON.stringify([relative(resources, file), stat.mode & 0o777, stat.isDirectory() ? "dir" : stat.isSymbolicLink() ? "link" : "file"]));
      if (stat.isSymbolicLink()) hash.update(readlinkSync(file));
      else if (stat.isDirectory()) walk(file);
      else if (stat.isFile()) hash.update(readFileSync(file));
      else fail("unsupported native resource");
    }
  }
  walk(resources); return hash.digest("hex");
}

export function nativeSourceDigest(repo, commit) {
  if (!/^[0-9a-f]{40}$/.test(commit)) fail("invalid source commit");
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { maxBuffer: 64 * 1024 * 1024 });
  const inventory = git("ls-tree", "-r", "--full-tree", commit).toString().split("\n").filter(Boolean);
  const hash = createHash("sha256");
  for (const entry of inventory) {
    const name = entry.slice(entry.indexOf("\t") + 1);
    // Updater scripts, server and renderer are rebuilt; all packaged native
    // inputs/build recipes are conservatively treated as shell requirements.
    if (name.startsWith("electron/resources/updater/")) continue;
    if (/^(electron\/|companion\/|skills\/|scripts\/|build\/|third_party\/|electron-builder[^/]*\.yml$|pnpm-lock\.yaml$)/.test(name)) hash.update(entry + "\n");
  }
  const pkg = JSON.parse(git("show", `${commit}:package.json`).toString());
  // Application version/source labels do not change native capabilities.
  delete pkg.version; delete pkg.bosSourceCommit;
  hash.update(JSON.stringify(pkg));
  return hash.digest("hex");
}

export function stampNativeContract(resources, repo, commit) {
  const contract = { schema: 1, shellCommit: commit, sourceSha256: nativeSourceDigest(repo, commit), resourcesSha256: nativeResourceDigest(resources) };
  writeFileSync(join(resources, NATIVE_CONTRACT_FILE), JSON.stringify(contract, null, 2) + "\n", { mode: 0o644 });
  return contract;
}

export function assertNativeCompatibility(resources, repo, commit) {
  let saved;
  try { saved = JSON.parse(readFileSync(join(resources, NATIVE_CONTRACT_FILE), "utf8")); } catch { fail("missing package identity"); }
  if (saved?.schema !== 1 || !/^[0-9a-f]{40}$/.test(saved.shellCommit ?? "") || !/^[0-9a-f]{64}$/.test(saved.sourceSha256 ?? "")) fail("invalid package identity");
  if (nativeResourceDigest(resources) !== saved.resourcesSha256) fail("native resources changed after packaging");
  if (nativeSourceDigest(repo, saved.shellCommit) !== saved.sourceSha256) fail("shell source identity mismatch");
  if (nativeSourceDigest(repo, commit) !== saved.sourceSha256) fail("target requires another native shell");
  return saved;
}
