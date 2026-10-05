import { chmodSync, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { IPty } from "node-pty";

const requirePty = createRequire(import.meta.url);
let ptyModule: typeof import("node-pty") | undefined;

function loadPty(): typeof import("node-pty") {
  if (ptyModule) return ptyModule;
  // import.meta.url points at server/terminal-pty.ts in development and at
  // dist-server/index.js once inlined. Native addons cannot be inlined by
  // esbuild; their original CommonJS layout lives beside the packaged server.
  const vendor = join(dirname(fileURLToPath(import.meta.url)), "vendor", "node-pty");
  const packaged = existsSync(join(vendor, "package.json"));
  const packageRoot = packaged ? vendor : dirname(requirePty.resolve("node-pty/package.json"));
  if (!packaged && process.platform !== "win32") {
    // Some node-pty npm prebuilds ship the helper as 0644. pnpm's disabled
    // install scripts leave it that way, and fork then fails with posix_spawnp.
    // Packaged helpers already have this bit set by bundle-server.mjs, so the
    // installed app never needs to write to its resources directory.
    for (const relative of ["build/Release", "build/Debug", `prebuilds/${process.platform}-${process.arch}`]) {
      const helper = join(packageRoot, relative, "spawn-helper");
      if (existsSync(helper)) {
        const mode = statSync(helper).mode;
        if (!(mode & 0o100)) chmodSync(helper, mode | 0o100);
      }
    }
  }
  ptyModule = requirePty(join(packageRoot, "lib", "index.js")) as typeof import("node-pty");
  return ptyModule;
}

/** Called only after the terminal ticket and WebSocket have been authorized. */
export function spawnTerminalPty(cwd: string): IPty {
  const shell = process.platform === "win32"
    ? process.env.ComSpec || "cmd.exe"
    : process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/sh");
  return loadPty().spawn(shell, [], {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd,
    env: { ...process.env, TERM: "xterm-256color" },
  });
}
