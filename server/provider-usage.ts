import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { InstanceConfigMap } from "./contracts.ts";
import { accountDirectory, configuredAccountDirectory } from "./claude-accounts.ts";

const execFileAsync = promisify(execFile);
type Window = { usedPercent: number | null; resetsAt: number | null };
export type ProviderUsage = {
  provider: "claude" | "codex";
  account: string;
  /** Stable provider routing identity; account remains a display label. */
  instanceId?: string;
  fiveHour?: Window;
  sevenDay: Window;
  status: "available" | "unavailable";
  /** When these numbers were read from the provider, ms since epoch. */
  checkedAt?: number;
  /** The latest read failed or was skipped; these are the last good numbers. */
  stale?: boolean;
};
const percentage = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, value));
};
const reset = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
  }
  return null;
};

export function mapClaudeUsage(account: string, data: any): ProviderUsage {
  const window = (key: string): Window => ({
    usedPercent: percentage(data?.[key]?.utilization),
    resetsAt: reset(data?.[key]?.resets_at),
  });
  const fiveHour = window("five_hour");
  const sevenDay = window("seven_day");
  return { provider: "claude", account, fiveHour, sevenDay,
    status: fiveHour.usedPercent !== null || sevenDay.usedPercent !== null ? "available" : "unavailable" };
}

export function mapCodexUsage(account: string, data: any): ProviderUsage {
  const windows = [data?.rate_limit?.primary_window, data?.rate_limit?.secondary_window];
  const weekly = windows.find((window) => window?.limit_window_seconds === 604800)
    ?? windows.find((window) => window?.limit_window_seconds >= 6 * 86400);
  const sevenDay = {
    usedPercent: percentage(weekly?.used_percent),
    resetsAt: reset(weekly?.reset_at),
  };
  return { provider: "codex", account, sevenDay,
    status: sevenDay.usedPercent !== null ? "available" : "unavailable" };
}

async function readJson(path: string): Promise<any> {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; }
}

export function claudeCredentialService(selectedDirectory: string): string {
  return "Claude Code-credentials" + (selectedDirectory
    ? "-" + createHash("sha256").update(selectedDirectory.normalize("NFC")).digest("hex").slice(0, 8) : "");
}

type CredentialIO = {
  platform: string; home: string; hostHome: string; username: string;
  file: (path: string) => Promise<any>;
  keychain: (service: string, username: string) => Promise<any>;
};
export async function readClaudeUsageToken(dir: string, selectedDirectory: string, io?: CredentialIO): Promise<string | null> {
  const source = io ?? {
    platform: process.platform, home: process.env.HOME ?? homedir(), hostHome: userInfo().homedir, username: userInfo().username,
    file: readJson,
    keychain: async (service: string, username: string) => {
      const result = await execFileAsync("security", ["find-generic-password", "-s", service, "-a", username, "-w"], { timeout: 3000 });
      return JSON.parse(result.stdout);
    },
  };
  const candidates: any[] = [];
  try { candidates.push(await source.file(join(dir, ".credentials.json"))); } catch { /* Missing file. */ }
  // Only the selected account's exact Keychain service is eligible. A fixture
  // HOME never falls through to the real user's store, even for named accounts.
  if (source.platform === "darwin" && source.home === source.hostHome) {
    try { candidates.push(await source.keychain(claudeCredentialService(selectedDirectory), source.username)); } catch { /* Locked or absent store. */ }
  }
  const valid = candidates.map(credentials => credentials?.claudeAiOauth ?? credentials?.claude_ai_oauth)
    .filter(oauth => oauth && typeof (oauth.accessToken ?? oauth.access_token) === "string"
      && (oauth.accessToken ?? oauth.access_token).length > 0
      && !(typeof (oauth.expiresAt ?? oauth.expires_at) === "number" && (oauth.expiresAt ?? oauth.expires_at) < Date.now() + 60_000))
    .sort((a, b) => (b.expiresAt ?? b.expires_at ?? 0) - (a.expiresAt ?? a.expires_at ?? 0));
  return valid[0]?.accessToken ?? valid[0]?.access_token ?? null;
}

type Fetched = { data: any; retryAfterMs: number | null };
async function requestJson(url: string, headers: Record<string, string>): Promise<Fetched> {
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
    if (response.ok) return { data: await response.json(), retryAfterMs: null };
    const seconds = Number(response.headers.get("retry-after"));
    return { data: null, retryAfterMs: response.status === 429 ? (Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 5 * 60_000) : null };
  } catch { return { data: null, retryAfterMs: null }; }
}

// Anthropic rate-limits /api/oauth/usage per token and locks it out for up to
// an hour when polled too often, and the numbers move slowly. So each account
// is read at most every FRESH_MS, a 429 is honoured, a failure waits
// FAILURE_MS, and the last good reading keeps showing (marked stale) instead
// of "Unavailable". Bot turns ask for usage constantly, so they all share this.
export const FRESH_MS = 5 * 60_000;
const FAILURE_MS = 2 * 60_000;
const MAX_BACKOFF_MS = 60 * 60_000;
type Slot = { good: ProviderUsage | null; last: ProviderUsage | null; nextAt: number; inflight: Promise<ProviderUsage> | null };
const slots = new Map<string, Slot>();

/** A stale window whose reset has passed has started over; don't keep its old percentage. */
function ageWindow(window: Window | undefined, now: number): Window | undefined {
  if (!window || window.resetsAt === null || window.resetsAt * 1000 > now) return window;
  return { usedPercent: window.usedPercent === null ? null : 0, resetsAt: null };
}
function stale(good: ProviderUsage, now: number): ProviderUsage {
  return { ...good, stale: true, fiveHour: ageWindow(good.fiveHour, now), sevenDay: ageWindow(good.sevenDay, now)! };
}

export type UsageReader = () => Promise<{ row: ProviderUsage; retryAfterMs: number | null }>;
export async function cachedUsage(key: string, read: UsageReader, now: () => number = Date.now): Promise<ProviderUsage> {
  const slot = slots.get(key) ?? { good: null, last: null, nextAt: 0, inflight: null };
  slots.set(key, slot);
  if (slot.inflight) return slot.inflight;
  if (now() < slot.nextAt && slot.good) return slot.good.stale ? stale(slot.good, now()) : slot.good;
  if (now() < slot.nextAt && slot.last) return slot.last;
  slot.inflight = (async () => {
    try {
      const result = await read().catch(() => null);
      if (result?.row.status === "available") {
        slot.good = slot.last = { ...result.row, checkedAt: now(), stale: false };
        slot.nextAt = now() + FRESH_MS;
        return slot.good;
      }
      slot.nextAt = now() + Math.min(MAX_BACKOFF_MS, result?.retryAfterMs ?? FAILURE_MS);
      if (slot.good) {
        slot.good = { ...slot.good, stale: true };
        return stale(slot.good, now());
      }
      if (!result) throw new Error("usage read failed");
      slot.last = result.row;
      return result.row;
    } finally { slot.inflight = null; }
  })();
  return slot.inflight;
}
/** Test hook. */
export function resetUsageCache(): void { slots.clear(); }

export async function providerUsage(instances: InstanceConfigMap): Promise<ProviderUsage[]> {
  const accounts = Object.entries(instances).filter(([, entry]) => entry.driver === "claudeAgent" || entry.driver === "codex");
  return Promise.all(accounts.map(([id, entry]): Promise<ProviderUsage> => {
    if (entry.driver === "claudeAgent") {
      const dir = accountDirectory(entry);
      return cachedUsage(`claude:${id}:${dir}`, async () => {
        const token = await readClaudeUsageToken(dir, configuredAccountDirectory(entry));
        const fetched = token ? await requestJson("https://api.anthropic.com/api/oauth/usage", {
          Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", "User-Agent": "claude-code/2.0.32",
        }) : { data: null, retryAfterMs: null };
        return { row: { ...mapClaudeUsage(entry.displayName ?? id, fetched.data), instanceId: id }, retryAfterMs: fetched.retryAfterMs };
      });
    }
    const codexHome = entry.environment?.CODEX_HOME ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
    return cachedUsage(`codex:${id}:${codexHome}`, async () => {
      const auth = await readJson(join(codexHome, "auth.json"));
      const token = auth?.tokens?.access_token;
      const account = auth?.tokens?.account_id;
      const fetched = token && account ? await requestJson("https://chatgpt.com/backend-api/wham/usage", {
        Authorization: `Bearer ${token}`, "ChatGPT-Account-ID": account,
      }) : { data: null, retryAfterMs: null };
      return { row: { ...mapCodexUsage(entry.displayName ?? id, fetched.data), instanceId: id }, retryAfterMs: fetched.retryAfterMs };
    });
  }));
}
