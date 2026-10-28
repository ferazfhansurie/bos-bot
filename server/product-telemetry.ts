import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { productEvent, type ProductEvent } from "../shared/product-events.ts";
import { anonymousInstall } from "./anonymous-install.ts";

export const PRODUCT_EVENTS_URL = "https://bosbot.my/api/events";
interface Options { dataDir: string; enabled: () => boolean; version: () => string; platform?: string; env?: NodeJS.ProcessEnv; fetch?: typeof fetch; now?: () => number; testInstallId?: string }
const ONCE = new Set(["install", "first_bot", "first_message", "first_job_done"]);
export class ProductTelemetry {
  private queue: ProductEvent[] = [];
  private seen = new Set<string>();
  /** when this install's first event was queued; time to first message runs from here */
  private installedAt?: number;
  private loaded = false;
  private stopped = false;
  private flushing?: Promise<void>;
  private interval?: ReturnType<typeof setInterval>;
  private controller?: AbortController;
  private readonly options: Options;
  constructor(options: Options) { this.options = options; }
  enabled(): boolean { return !this.stopped && (this.options.env ?? process.env).BOS_NO_PING !== "1" && this.options.enabled(); }
  installId(): string | null {
    if (!this.enabled()) return null;
    if (this.options.testInstallId !== undefined) return /^test-213-[a-zA-Z0-9_-]{1,55}$/.test(this.options.testInstallId) ? this.options.testInstallId : null;
    return anonymousInstall(this.options.dataDir)?.install_id ?? null;
  }
  referralUrl(): string | null {
    const id = this.installId();
    return id ? `https://bosbot.my/get?ref=${createHash("sha256").update(`bos-referral-v1:${id}`).digest("hex").slice(0, 16)}` : null;
  }
  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const state = JSON.parse(readFileSync(join(this.options.dataDir, "product-events.json"), "utf8"));
      this.seen = new Set(Array.isArray(state.seen) ? state.seen.filter((name: unknown) => typeof name === "string" && ONCE.has(name)) : []);
      if (Number.isSafeInteger(state.installedAt) && state.installedAt > 0) this.installedAt = state.installedAt;
      this.queue = Array.isArray(state.queue) ? state.queue.slice(-500).flatMap((event: ProductEvent) => {
        const clean = productEvent(event?.name, event?.props, Date.parse(event?.at)); return clean ? [clean] : [];
      }) : [];
    } catch { /* no queue, or corrupt queue: never send unvalidated data */ }
  }
  private save(): boolean {
    try {
      mkdirSync(this.options.dataDir, { recursive: true, mode: 0o700 });
      const file = join(this.options.dataDir, "product-events.json");
      writeFileSync(`${file}.tmp`, JSON.stringify({ seen: [...this.seen], queue: this.queue, ...(this.installedAt ? { installedAt: this.installedAt } : {}) }), { mode: 0o600 }); renameSync(`${file}.tmp`, file);
      return true;
    } catch { return false; }
  }
  track(name: string, props?: Record<string, unknown>): boolean {
    if (!this.enabled() || !this.installId()) return false;
    const now = (this.options.now ?? Date.now)();
    this.load();
    if (ONCE.has(name) && this.seen.has(name)) return false;
    // 3.0 only (the caller passes v3: true), and installs from before this
    // field never get one: no guessed durations. Clamped to the schema's cap
    // so a slow first message still reports, as "at least that long".
    const since = name === "first_message" && props?.v3 === true && this.installedAt && now >= this.installedAt
      ? { duration_ms: Math.min(now - this.installedAt, 1_000_000_000) } : {};
    const event = productEvent(name, { ...props, ...since }, now);
    if (!event) return false;
    if (name === "install") this.installedAt = now;
    if (ONCE.has(name)) this.seen.add(name);
    if (this.queue.length >= 500) this.queue.shift();
    this.queue.push(event);
    return this.save();
  }
  settingsChanged(): void {
    if (this.enabled()) return;
    this.controller?.abort(); this.load(); this.queue = []; this.save();
  }
  start(): void {
    if (this.interval || this.stopped) return;
    this.track("install"); this.track("open");
    this.interval = setInterval(() => { void this.flush(); }, 60_000); this.interval.unref();
  }
  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.send().finally(() => { this.flushing = undefined; }); return this.flushing;
  }
  private async send(): Promise<void> {
    if (!this.enabled()) { this.settingsChanged(); return; }
    const id = this.installId(); if (!id) return;
    this.load(); const events = this.queue.slice(0, 50); if (!events.length) return;
    this.controller = new AbortController();
    const timeout = setTimeout(() => this.controller?.abort(), 5000); timeout.unref();
    try {
      const response = await (this.options.fetch ?? fetch)(PRODUCT_EVENTS_URL, { method: "POST", headers: { "content-type": "application/json" }, credentials: "omit", redirect: "error", signal: this.controller.signal,
        body: JSON.stringify({ install_id: id, version: this.options.version(), platform: this.options.platform ?? process.platform, events }) });
      await response.body?.cancel();
      if (response.ok && this.enabled()) {
        const sent = new Set(events); this.queue = this.queue.filter(event => !sent.has(event)); this.save();
      }
    } catch { /* bounded persisted queue retries on next minute; no UI errors */ }
    finally { clearTimeout(timeout); this.controller = undefined; }
  }
  async stop(): Promise<void> {
    if (this.interval) { clearInterval(this.interval); this.interval = undefined; }
    // A bounded flush fits the server's existing graceful-shutdown deadline.
    const deadline = Date.now() + 4500;
    do {
      const before = this.queue.length;
      await this.flush();
      if (!this.queue.length || this.queue.length >= before) break;
    } while (Date.now() < deadline);
    this.stopped = true; this.controller?.abort();
  }
}
