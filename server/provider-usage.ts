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
      const token = await readClaudeUsageToken(accountDirectory(entry), configuredAccountDirectory(entry));
      const data = token ? await requestJson("https://api.anthropic.com/api/oauth/usage", {
        Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", "User-Agent": "claude-code/2.0.32",
      }) : null;
      return { ...mapClaudeUsage(entry.displayName ?? id, data), instanceId: id };
    }
    const codexHome = entry.environment?.CODEX_HOME ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
    const auth = await readJson(join(codexHome, "auth.json"));
    const token = auth?.tokens?.access_token;
    const account = auth?.tokens?.account_id;
    const data = token && account ? await requestJson("https://chatgpt.com/backend-api/wham/usage", {
      Authorization: `Bearer ${token}`, "ChatGPT-Account-ID": account,
    }) : null;
    return { ...mapCodexUsage(entry.displayName ?? id, data), instanceId: id };
  }));
  cache = { at: Date.now(), key, rows };
  return rows;
}
