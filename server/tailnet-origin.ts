import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tailscaleCandidates, tailscaleEnvironment } from "../companion/src/listener.ts";

const run = promisify(execFile);
const TAILSCALE_BUDGET_MS = 5_000;
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
  let key = "default";
  if (peer) {
    try {
      const host = new URL(peer).hostname.toLowerCase();
      if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ts\.net$/.test(host)) return null;
      key = host.split(".").slice(1).join(".");
    } catch { return null; }
  }
  const cached = cache.get(key);
  if (cached && cached.until > Date.now()) return cached.value;
  const statuses: Status[] = [];
  const deadline = Date.now() + TAILSCALE_BUDGET_MS;
  for (const binary of tailscaleCandidates()) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      const { stdout } = await run(binary, ["status", "--json"], {
        // The timeout kills this CLI child; a Promise race would leave it running.
        encoding: "utf8", timeout: remaining, maxBuffer: 512_000, killSignal: "SIGKILL",
        env: tailscaleEnvironment(),
      });
      const status: unknown = JSON.parse(stdout);
      if (status && typeof status === "object") statuses.push(status as Status);
      const match = selectTailnetOrigin(statuses, peer);
      if (match) {
        cache.set(key, { value: match, until: Date.now() + CACHE_MS });
        return match;
      }
    } catch { /* another installed client may be the running one */ }
  }
  const value = selectTailnetOrigin(statuses, peer);
  cache.set(key, { value, until: Date.now() + CACHE_MS });
  return value;
}
