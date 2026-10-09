import { compatEnv } from "../electron/branding-env.cjs";
import { stampNativeContract } from "../electron/native-contract.mjs";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { chmod, lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { LICENSE_FILES } from "./cua-linux-release.mjs";
import {
  executableTarget,
  verifyCloudflaredExecutable,
} from "./prepare-cloudflared.mjs";
import { verifyBrowserBundle } from "./prepare-browser.mjs";

async function requireRealDirectory(directory, mode = 0o755) {
  const details = await lstat(directory);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error(`Package resource must be a real directory: ${directory}`);
  }
  if (mode !== undefined) await chmod(directory, mode);
}

async function requireRegularFile(file, mode) {
  const details = await lstat(file);
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new Error(`Package resource must be a regular file: ${file}`);
  }
  if (mode !== undefined) await chmod(file, mode);
}

async function validateCloudflared(resources, platform, required) {
  const root = path.join(resources, "cloudflared");
  try {
    await lstat(root);
  } catch (error) {
    // Unit fixtures for the older CUA-only hook do not carry every packaged
    // resource. A real electron-builder context must fail closed because its
    // copier only warns when an extraResources `from` path is missing.
    if (error?.code === "ENOENT" && !required) return;
    throw error;
  }

  const unixMode = platform === "win32" ? undefined : 0o755;
  await requireRealDirectory(root, unixMode);
  const executable = path.join(root, platform === "win32" ? "cloudflared.exe" : "cloudflared");
  if (JSON.stringify(await readdir(root)) !== JSON.stringify([path.basename(executable)])) {
    throw new Error(`Unexpected entries in packaged cloudflared resource: ${root}`);
  }
  await requireRegularFile(executable, unixMode);
  const target = executableTarget(await readFile(executable));
  const allowed = {
    darwin: new Set(["darwin-arm64", "darwin-x64"]),
    linux: new Set(["linux-x64"]),
    win32: new Set(["win32-x64"]),
  }[platform];
  if (!allowed?.has(target)) {
    throw new Error(`Packaged ${platform} app contains the wrong cloudflared target: ${target}`);
  }
  verifyCloudflaredExecutable(executable, target);

  const licenses = path.join(resources, "licenses");
  await requireRealDirectory(licenses, unixMode);
  await requireRegularFile(
    path.join(licenses, "cloudflared-LICENSE.txt"),
    platform === "win32" ? undefined : 0o644,
  );
  await requireRegularFile(
    path.join(licenses, "cloudflared-README.md"),
    platform === "win32" ? undefined : 0o644,
  );
}

// Same digest as server/updater.ts treeDigest and updater/no-downgrade.py:
// files under Resources/<name> sorted by relative posix path, each hashed as
// path then bytes. The three must agree or the stamp is treated as missing.
function treeDigest(resources, name) {
  const root = path.join(resources, name);
  const details = lstatSync(root);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error(`Package resource must be a real directory: ${root}`);
  }
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) files.push(file);
    }
  };
  walk(root);
  const hash = createHash("sha256");
  for (const file of files.sort((a, b) => (path.relative(root, a).split(path.sep).join("/") < path.relative(root, b).split(path.sep).join("/") ? -1 : 1))) {
    hash.update(path.relative(root, file).split(path.sep).join("/"));
    hash.update(readFileSync(file));
  }
  return hash.digest("hex");
}

/** Resources/build-commit.json: the source commit this bundle was built from
 * plus the digests of the server and ui trees it describes. The updater's
 * no-downgrade guard refuses any bundle without a valid stamp, so a real
 * package with no bosSourceCommit fails here rather than shipping unstampable. */
export async function stampBuildCommit(resources, commit) {
  return stampBuildCommitSync(resources, commit);
}

// osx-sign's per-file options callback is synchronous. At the outer app it
// runs after every nested binary is signed and before the resource seal.
export function stampBuildCommitSync(resources, commit) {
  if (!/^[0-9a-f]{40}$/.test(commit ?? "")) throw new Error(`build stamp needs the full 40-hex source commit, got ${JSON.stringify(commit ?? null)}`);
  const stamp = {
    commit,
    server_sha256: treeDigest(resources, "server"),
    ui_sha256: treeDigest(resources, "ui"),
    stamped_at: new Date().toISOString(),
    ...(existsSync(path.join(resources, "native-contract.json")) ? { native_contract_sha256: createHash("sha256").update(readFileSync(path.join(resources, "native-contract.json"))).digest("hex") } : {}),
  };
  writeFileSync(path.join(resources, "build-commit.json"), `${JSON.stringify(stamp, null, 2)}
`, { mode: 0o644 });
  return stamp;
}

export function packagedSourceCommit(context) {
  const metadata = context.packager?.metadata ?? {};
  const extra = context.packager?.config?.extraMetadata ?? {};
  return metadata.bosSourceCommit ?? extra.bosSourceCommit ?? compatEnv.BOS_SOURCE_COMMIT ?? null;
}

// electron-builder normalizes copied resource directories to 0775. That is
// unsafe for a root-owned executable path after DEB/AppImage installation, so
// repair and revalidate the exact tree after resources are copied and before
// either artifact target is assembled.
export default async function afterPack(context) {
  const resources = context.packager?.getResourcesDir?.(context.appOutDir) ?? (
    context.electronPlatformName === "darwin"
      ? path.join(context.appOutDir, "BOS Bot.app", "Contents", "Resources")
      : path.join(context.appOutDir, "resources")
  );
  await validateCloudflared(resources, context.electronPlatformName, Boolean(context.packager));
  // Stamp every real package (mac-sign refreshes it before the outer app seal).
  // Unit fixtures for the older hooks carry no
  // server/ui trees and no commit, so they are left unstamped.
  const sourceCommit = packagedSourceCommit(context);
  if (context.packager && context.electronPlatformName === "darwin") {
    stampNativeContract(resources, context.packager.projectDir, sourceCommit);
  }
  if (context.packager || sourceCommit) await stampBuildCommit(resources, sourceCommit);
  const browserRoot = path.join(resources, "browser-engine");
  const hasBrowser = await lstat(browserRoot).then(() => true, (error) => {
    if (error?.code === "ENOENT") return false;
    throw error;
  });
  // electron-builder warns and skips missing extraResources. A real package
  // must fail here, before signing, rather than silently ship without Chrome.
  if (hasBrowser || context.packager) {
    const arch = { 1: "x64", 3: "arm64" }[context.arch];
    if (!arch) throw new Error(`Unsupported desktop browser package architecture: ${context.arch}`);
    await verifyBrowserBundle(browserRoot, `${context.electronPlatformName}-${arch}`);
  }

  if (context.electronPlatformName !== "linux") return;

  const cuaRoot = path.join(resources, "cua-linux-x64");
  const licenses = path.join(cuaRoot, "licenses");
  for (const directory of [context.appOutDir, resources, cuaRoot, licenses]) {
    await requireRealDirectory(directory);
  }
  for (const executable of ["cua-driver", "cua-cursor-theme"]) {
    await requireRegularFile(path.join(cuaRoot, executable), 0o755);
  }
  await requireRegularFile(path.join(cuaRoot, "release.json"), 0o644);
  for (const license of LICENSE_FILES) {
    await requireRegularFile(path.join(licenses, license), 0o644);
  }
}
