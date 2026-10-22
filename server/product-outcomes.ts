import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { productHealth } from "./product-health.ts";
interface Options { dataDir: string; version: () => string; record: (name: string, props?: Record<string, unknown>) => void; now?: () => number }
interface State { version?: string; crashCount?: number; recoveryAt?: number }
function read(file: string): unknown {
  try { return statSync(file).size <= 32768 ? JSON.parse(readFileSync(file, "utf8")) : null; } catch { return null; }
}
/** Observe only the small typed receipts written by update/heal. No report text leaves this module. */
export class ProductOutcomes {
  private readonly options: Options;
  constructor(options: Options) { this.options = options; }
  observe(): void {
    try {
      const file = join(this.options.dataDir, "product-observed.json");
      const previous = read(file) as State | null;
      const state: State = {};
      const version = this.options.version();
      if (/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version)) {
        state.version = version;
        if (typeof previous?.version === "string" && previous.version !== version && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(previous.version)) this.options.record("update_installed");
      }
      const health = productHealth(this.options.dataDir);
      if (health.crash_count !== undefined) {
        state.crashCount = health.crash_count;
        if (Number.isSafeInteger(previous?.crashCount) && previous!.crashCount! >= 0 && health.crash_count > previous!.crashCount!) this.options.record("error", { class: "server", count: health.crash_count - previous!.crashCount! });
      }
      const now = (this.options.now ?? Date.now)();
      state.recoveryAt = typeof previous?.recoveryAt === "number" && Number.isFinite(previous.recoveryAt) ? previous.recoveryAt : 0;
      const notices = read(join(this.options.dataDir, "recovery-notices.json"));
      if (Array.isArray(notices)) for (const row of notices.slice(0, 3)) {
        if (!["bots.json", "groups.json", "messages.db"].includes(row?.collection) || typeof row.at !== "number" || !Number.isFinite(row.at) || row.at <= state.recoveryAt || row.at > now) continue;
        if (row.status === "restored" && now - row.at <= 10 * 60_000) this.options.record("heal_ran", { check: "storage" });
        state.recoveryAt = Math.max(state.recoveryAt, row.at);
      }
      writeFileSync(`${file}.tmp`, JSON.stringify(state), { mode: 0o600 }); renameSync(`${file}.tmp`, file);
    } catch { /* State I/O never changes the app or recovery outcome. */ }
  }
}
