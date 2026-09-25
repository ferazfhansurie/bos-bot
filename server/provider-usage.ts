import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { InstanceConfigMap } from "./contracts.ts";
import { accountDirectory } from "./claude-accounts.ts";

const execFileAsync = promisify(execFile);
type Window = { usedPercent: number | null; resetsAt: number | null };
export type ProviderUsage = {
  provider: "claude" | "codex";
  account: string;
  fiveHour?: Window;
  sevenDay: Window;
  status: "available" | "unavailable";
};
const percentage = (value: unknown, utilization = false): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, utilization && value <= 1 ? value * 100 : value));
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
    usedPercent: percentage(data?.[key]?.utilization, true),
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

async function claudeToken(dir: string): Promise<string | null> {
  let credentials = await readJson(join(dir, ".credentials.json"));
  // A fixture's temporary HOME must never make its read fall through to the
  // host user's real Keychain.
  if (!credentials && process.platform === "darwin" && process.env.HOME === userInfo().homedir && dir === join(homedir(), ".claude")) {
    try {
      const result = await execFileAsync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-a", userInfo().username, "-w"], { timeout: 3000 });
      credentials = JSON.parse(result.stdout);
    } catch { /* Login may be unavailable on this host. */ }
  }
  const oauth = credentials?.claudeAiOauth ?? credentials?.claude_ai_oauth;
  const expiry = oauth?.expiresAt ?? oauth?.expires_at;
  if (typeof expiry === "number" && expiry < Date.now() + 60_000) return null;
  return oauth?.accessToken ?? oauth?.access_token ?? null;
}

async function requestJson(url: string, headers: Record<string, string>): Promise<any> {
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
    return response.ok ? await response.json() : null;
  } catch { return null; }
}

let cache: { at: number; key: string; rows: ProviderUsage[] } | null = null;
export async function providerUsage(instances: InstanceConfigMap): Promise<ProviderUsage[]> {
  const accounts = Object.entries(instances).filter(([, entry]) => entry.driver === "claudeAgent" || entry.driver === "codex");
  const key = accounts.map(([id, entry]) => `${id}:${entry.driver}:${entry.driver === "claudeAgent" ? accountDirectory(entry) : ""}`).join("|");
  if (cache && cache.key === key && Date.now() - cache.at < 30_000) return cache.rows;
  const rows = await Promise.all(accounts.map(async ([id, entry]): Promise<ProviderUsage> => {
    if (entry.driver === "claudeAgent") {
      const token = await claudeToken(accountDirectory(entry));
      const data = token ? await requestJson("https://api.anthropic.com/api/oauth/usage", {
        Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", "User-Agent": "claude-code/2.0.32",
      }) : null;
      return mapClaudeUsage(entry.displayName ?? id, data);
    }
    const codexHome = entry.environment?.CODEX_HOME ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
    const auth = await readJson(join(codexHome, "auth.json"));
    const token = auth?.tokens?.access_token;
    const account = auth?.tokens?.account_id;
    const data = token && account ? await requestJson("https://chatgpt.com/backend-api/wham/usage", {
      Authorization: `Bearer ${token}`, "ChatGPT-Account-ID": account,
    }) : null;
    return mapCodexUsage(entry.displayName ?? id, data);
  }));
  cache = { at: Date.now(), key, rows };
  return rows;
}
