import { randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { anonymousInstall } from "./anonymous-install.ts";
import { productHealth } from "./product-health.ts";

export const USAGE_PING_URL = "https://bos.aihlete.com/api/ping";
export const USAGE_PING_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const USAGE_PING_TIMEOUT_MS = 5_000;
type Engine = "claude" | "codex";
export interface UsageCounts {
  engines: readonly string[];
  bots: number;
  rooms: number;
  room_humans_max: number;
  room_bots_max: number;
}
interface Options {
  dataDir: string;
  enabled: () => boolean;
  counts: () => UsageCounts;
  version: () => string;
  env?: NodeJS.ProcessEnv;
  platform?: string;
  arch?: string;
  now?: () => number;
  fetch?: typeof fetch;
}

function count(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** Only aggregate sizes leave this module; never spread a store/provider record. */
export function usageRoomCounts(rooms: readonly { humans: number; bots: number }[]) {
  return {
    rooms: rooms.length,
    room_humans_max: rooms.reduce((max, room) => Math.max(max, count(room.humans)), 0),
    room_bots_max: rooms.reduce((max, room) => Math.max(max, count(room.bots)), 0),
  };
}

/** One durable attempt per rolling 24 hours, including failed requests.
 * All I/O is detached from startup/settings; no retries or app-facing errors. */
export class AnonymousUsagePing {
  private busy = false;
  private stopped = false;
  private controller?: AbortController;
  private interval?: ReturnType<typeof setInterval>;
  private readonly options: Options;
  constructor(options: Options) { this.options = options; }

  private enabled(): boolean {
    return !this.stopped && (this.options.env ?? process.env).BOS_NO_PING !== "1" && this.options.enabled();
  }

  start(): void {
    if (this.interval || this.stopped) return;
    this.interval = setInterval(() => { void this.tick(); }, 60_000);
    this.interval.unref();
    void this.tick();
  }

  settingsChanged(): void {
    if (!this.enabled()) this.controller?.abort();
    else void this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.interval) clearInterval(this.interval);
    this.controller?.abort();
  }

  async tick(): Promise<void> {
    if (this.busy || !this.enabled()) return;
    const platform = this.options.platform ?? process.platform;
    const arch = this.options.arch ?? process.arch;
    if (!["darwin", "win32", "linux", "ios", "android"].includes(platform) || !["arm64", "x64"].includes(arch)) return;
    this.busy = true;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const file = join(this.options.dataDir, "anonymous-usage.json");
      const state = anonymousInstall(this.options.dataDir);
      if (!state) return;
      const now = (this.options.now ?? Date.now)();
      if (state.last_attempt_at !== undefined && now - state.last_attempt_at < USAGE_PING_INTERVAL_MS) return;
      if (!this.enabled()) return;
      const counts = this.options.counts();
      const payload = {
        install_id: state.install_id,
        version: this.options.version(), platform, arch,
        engines: (["claude", "codex"] as Engine[]).filter(engine => counts.engines.includes(engine)),
        bots: count(counts.bots), rooms: count(counts.rooms),
        room_humans_max: count(counts.room_humans_max), room_bots_max: count(counts.room_bots_max),
        event: state.last_attempt_at === undefined ? "first_run" : "daily",
        ...productHealth(this.options.dataDir),
      };
      // Commit before the request: a restart/offline receiver cannot cause a burst.
      await mkdir(this.options.dataDir, { recursive: true });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        const handle = await open(temporary, "wx", 0o600);
        try {
          await handle.writeFile(JSON.stringify({ install_id: state.install_id, last_attempt_at: now }));
          await handle.sync();
        } finally { await handle.close(); }
        await rename(temporary, file);
      } finally { await unlink(temporary).catch(() => {}); }
      if (!this.enabled()) return;
      this.controller = new AbortController();
      timeout = setTimeout(() => this.controller?.abort(), USAGE_PING_TIMEOUT_MS);
      timeout.unref();
      const response = await (this.options.fetch ?? fetch)(USAGE_PING_URL, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(payload), signal: this.controller.signal,
        credentials: "omit", redirect: "error",
      });
      await response.body?.cancel();
    } catch {
      // Intentionally silent: telemetry failure must not affect normal work.
    } finally {
      if (timeout) clearTimeout(timeout);
      this.controller = undefined;
      this.busy = false;
    }
  }
}
