import { chmodSync, copyFileSync, cpSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { executableTarget } from "./prepare-cloudflared.mjs";

const runtimeFile = (path) => /\.(node|dll|exe)$/.test(path) || basename(path) === "spawn-helper";

function nativeFiles(directory, prefix = "") {
  return readdirSync(join(directory, prefix), { withFileTypes: true }).flatMap((entry) => {
    const relative = join(prefix, entry.name);
    if (entry.isDirectory()) return relative === "conpty" ? nativeFiles(directory, relative) : [];
    return runtimeFile(relative) ? [relative] : [];
  });
}

/** Stage only a complete runtime whose native files match the build host.
 * node-pty's loader falls back when Release cannot load; existence alone must
 * not let an old Rosetta build hide a usable host prebuild. */
export function stageNodePty(source, destination, { platform = process.platform, arch = process.arch } = {}) {
  const target = `${platform}-${arch}`;
  rmSync(destination, { recursive: true, force: true });
  const required = platform === "win32" ? ["conpty.node", "conpty_console_list.node"] : ["pty.node", "spawn-helper"];
  const failures = [];
  let nativeRelative;
  for (const relative of ["build/Release", `prebuilds/${target}`]) {
    try {
      const directory = join(source, relative);
      const files = nativeFiles(directory);
      for (const file of new Set([...required, ...files])) {
        const actual = executableTarget(readFileSync(join(directory, file)));
        if (actual !== target) throw new Error(`${file} architecture mismatch: expected ${target}, received ${actual}`);
      }
      nativeRelative = relative;
      break;
    } catch (error) {
      failures.push(`${relative}: ${error.message}`);
    }
  }
  if (!nativeRelative) throw new Error(`node-pty has no native runtime for ${target}; build it on the release target first (${failures.join("; ")})`);

  mkdirSync(destination, { recursive: true });
  for (const file of ["package.json", "LICENSE"]) copyFileSync(join(source, file), join(destination, file));
  cpSync(join(source, "lib"), join(destination, "lib"), {
    recursive: true,
    filter: (path) => !path.endsWith(".test.js") && !path.endsWith(".map"),
  });
  const nativeSource = join(source, nativeRelative);
  cpSync(nativeSource, join(destination, nativeRelative), {
    recursive: true,
    filter: (path) => path === nativeSource || path === join(nativeSource, "conpty") || runtimeFile(path),
  });
  // npm prebuild helpers can be 0644 when install scripts are disabled.
  if (platform !== "win32") chmodSync(join(destination, nativeRelative, "spawn-helper"), 0o755);
  return nativeRelative;
}
