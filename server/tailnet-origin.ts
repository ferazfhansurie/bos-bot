import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

const TAILSCALE_BINARIES = [
  "/usr/local/bin/tailscale",
  "/opt/homebrew/bin/tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
];

/** Private HTTPS address for this desktop's already configured Tailscale Serve. */
export function tailnetOrigin(): string | null {
  for (const binary of TAILSCALE_BINARIES) {
    if (!existsSync(binary)) continue;
    try {
      const status = JSON.parse(execFileSync(binary, ["status", "--json"], {
        encoding: "utf8", timeout: 5_000, maxBuffer: 512_000, stdio: ["ignore", "pipe", "ignore"],
      })) as { Self?: { DNSName?: unknown } };
      const hostname = String(status.Self?.DNSName ?? "").replace(/\.$/, "").toLowerCase();
      if (/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ts\.net$/.test(hostname)) return `https://${hostname}:8443`;
    } catch { /* Another installation path may be active. */ }
  }
  return null;
}
