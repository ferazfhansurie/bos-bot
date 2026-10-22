import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_APP_CONFIG, parseAppConfig, type AppConfig } from "../shared/app-config.ts";

export const APP_CONFIG_URL = "https://bosbot.my/api/app-config";
export class AppConfigClient {
  private config: AppConfig = structuredClone(DEFAULT_APP_CONFIG);
  private running?: Promise<void>;
  private readonly options: { dataDir: string; fetch?: typeof fetch };
  constructor(options: { dataDir: string; fetch?: typeof fetch }) {
    this.options = options;
    try { this.config = parseAppConfig(JSON.parse(readFileSync(join(options.dataDir, "app-config.json"), "utf8"))); } catch { /* offline defaults */ }
  }
  current(): AppConfig { return structuredClone(this.config); }
  refresh(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.fetchConfig().finally(() => { this.running = undefined; });
    return this.running;
  }
  private async fetchConfig(): Promise<void> {
    try {
      const response = await (this.options.fetch ?? fetch)(APP_CONFIG_URL, { cache: "no-store", credentials: "omit", redirect: "error", signal: AbortSignal.timeout(5000) });
      if (!response.ok || Number(response.headers.get("content-length")) > 131072) { await response.body?.cancel(); return; }
      const reader = response.body?.getReader();
      if (!reader) return;
      const chunks: Uint8Array[] = []; let length = 0;
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          length += value.length;
          if (length > 131072) { await reader.cancel(); return; }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (value?.version !== 1) return;
      const config = parseAppConfig(value);
      mkdirSync(this.options.dataDir, { recursive: true, mode: 0o700 });
      const file = join(this.options.dataDir, "app-config.json");
      writeFileSync(`${file}.tmp`, JSON.stringify(config), { mode: 0o600 });
      renameSync(`${file}.tmp`, file);
      this.config = config;
    } catch { /* A config outage must never block opening BOS. */ }
  }
}
