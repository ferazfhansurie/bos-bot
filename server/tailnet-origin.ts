import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

const run = promisify(execFile);
const TAILSCALE_BINARIES = [
  "/usr/local/bin/tailscale",
  "/opt/homebrew/bin/tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
];
const CACHE_MS = 30_000;
const cache = new Map<string, { value: string | null; until: number }>();

interface Status { BackendState?: unknown; Self?: { DNSName?: unknown } }

function hostname(status: Status): string | null {
  if (status.BackendState !== "Running") return null;
  const value = String(status.Self?.DNSName ?? "").replace(/\.$/, "").toLowerCase();
  return /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ts\.net$/.test(value) ? value : null;
}

export function selectTailnetOrigin(statuses: Status[], peer?: string): string | null {
  let suffix: string | undefined;
  if (peer) {
    try {
      const host = new URL(peer).hostname.toLowerCase();
      if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ts\.net$/.test(host)) return null;
      suffix = host.slice(host.indexOf(".") + 1);
    } catch { return null; }
  }
  const match = statuses.map(hostname).find(value => value && (!suffix || value.slice(value.indexOf(".") + 1) === suffix));
  return match ? `https://${match}:8443` : null;
}

/** Private HTTPS origin from a Running client on the peer's tailnet. */
export async function tailnetOrigin(peer?: string): Promise<string | null> {
  const key = peer ? new URL(peer).hostname.toLowerCase().split(".").slice(1).join(".") : "default";
  const cached = cache.get(key);
  if (cached && cached.until > Date.now()) return cached.value;
  const statuses: Status[] = [];
  for (const binary of TAILSCALE_BINARIES) {
    if (!existsSync(binary)) continue;
    try {
      const { stdout } = await run(binary, ["status", "--json"], {
        encoding: "utf8", timeout: 5_000, maxBuffer: 512_000,
        env: { ...process.env, TAILSCALE_BE_CLI: "1" },
      });
      statuses.push(JSON.parse(stdout) as Status);
    } catch { /* another installed client may be the running one */ }
  }
  const value = selectTailnetOrigin(statuses, peer);
  cache.set(key, { value, until: Date.now() + CACHE_MS });
  return value;
}
