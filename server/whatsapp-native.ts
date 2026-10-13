// Native WhatsApp capture and gated reply transport over a linked device.
//
// One WhatsAppNative owns at most one client at a time (one Chromium on one
// LocalAuth profile). Its state is never asserted, only observed: every value
// comes from a client event (qr, authenticated, ready, auth_failure,
// disconnected, change_state) or from the periodic liveness probe
// (client.getState()), so a dead puppeteer page reads as disconnected rather
// than a stale "linked".
//
// Failures retry with exponential backoff, but only while a saved session
// exists (a QR flow is the person's to restart), and a circuit breaker stops
// after maxFailures consecutive failures until the person presses Reconnect.
//
// Capture arrives as plain records; optional reply/history transports stay
// behind server-side account, scope and authorization checks.
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readlinkSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { LOADED_RUNTIMES } from "./proxy-paths.ts";
import type { BrowserResolution } from "./whatsapp-browser.ts";
import type {
  CapturedMessage,
  CreateReadOnlyClient,
  ReadOnlyClientHandlers,
  ReadOnlyWhatsAppClient,
  WhatsAppLinkState,
} from "./whatsapp-types.ts";

export type { WhatsAppLinkState } from "./whatsapp-types.ts";

export interface WhatsAppNativeSnapshot {
  state: WhatsAppLinkState;
  /** raw QR payload while state is qr_pending; the UI renders it */
  qr: string | null;
  /** plain-language detail for the tile (why disconnected, what to do) */
  reason: string | null;
  sessionExists: boolean;
  browser: BrowserResolution | null;
  failures: number;
  circuitOpen: boolean;
  nextRetryAt: number | null;
  linkedAt: number | null;
  updatedAt: number;
  messageCount: number;
}

interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
  setInterval: (fn, ms) => {
    const handle = setInterval(fn, ms);
    handle.unref?.();
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
};

export interface WhatsAppNativeOptions {
  authDir: string;
  clientId: string;
  loadFactory: () => Promise<CreateReadOnlyClient>;
  resolveBrowser: () => BrowserResolution | null;
  noBrowserReason?: () => string;
  store: { insert(message: CapturedMessage): boolean; count(): number };
  /** "Saved" means a session that has reached `ready` at least once: only
   * then does BOS resume it at boot or retry after a failure. A half-done
   * QR flow leaves a LocalAuth profile on disk but no marker. */
  marker?: LinkedMarker;
  /** where the default file marker lives (<data>/whatsapp/linked.json) */
  markerFile?: string;
  /** force-kills one process (a client's own Chromium) after destroy() hangs */
  killProcess?: (pid: number) => void;
  /** how long a new launch waits for the previous client's destroy() */
  destroyTimeoutMs?: number;
  /** frees a profile left locked by a crashed previous run */
  releaseStaleProfile?: (sessionDir: string) => void;
  /** drops a session WhatsApp rejected, so Rescan shows a fresh QR code */
  clearSession?: (sessionDir: string) => void;
  timers?: Timers;
  now?: () => number;
  log?: (line: string) => void;
  onChange?: (snapshot: WhatsAppNativeSnapshot) => void;
  onCaptured?: (message: CapturedMessage) => void;
  probeIntervalMs?: number;
  probeTimeoutMs?: number;
  /** a start that produces no lifecycle event for this long is a failure */
  startTimeoutMs?: number;
  /** loading the client runtime longer than this is a (retryable) failure */
  loadTimeoutMs?: number;
  maxFailures?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  qrMaxRetries?: number;
  deviceName?: string;
}

const RESCAN_DISCONNECTS = /^(LOGOUT|UNPAIRED|UNPAIRED_IDLE)$/i;
const QR_EXHAUSTED = /max qr ?code retries/i;

export function sessionDirFor(authDir: string, clientId: string): string {
  return join(authDir, `session-${clientId}`);
}

export interface LinkedMarker {
  exists(): boolean;
  write(): void;
  remove(): void;
}

/** A small JSON file, written atomically (temp file + rename). */
export function fileLinkedMarker(file: string, now: () => number = Date.now): LinkedMarker {
  return {
    exists: () => existsSync(file),
    write: () => {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      const temp = `${file}.${process.pid}.tmp`;
      writeFileSync(temp, `${JSON.stringify({ linkedAt: now() })}\n`, { mode: 0o600 });
      renameSync(temp, file);
    },
    remove: () => rmSync(file, { force: true }),
  };
}

/** Chrome refuses a profile whose SingletonLock names a live process. After a
 * crash (SIGKILL, power loss) the lock is left behind, possibly with the old
 * Chromium still running on it. Remove a dead lock; stop an orphan only when
 * its command line names this exact profile, so nothing else is touched. */
export function releaseStaleProfile(sessionDir: string): void {
  const lock = join(sessionDir, "SingletonLock");
  let target: string;
  try {
    if (!lstatSync(lock).isSymbolicLink()) return;
    target = readlinkSync(lock);
  } catch {
    return;
  }
  const pid = Number(target.split("-").at(-1));
  let alive = false;
  if (Number.isInteger(pid) && pid > 1) {
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {}
  }
  if (alive && process.platform !== "win32") {
    try {
      const command = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 2_000 });
      if (!command.includes(sessionDir)) return;
      process.kill(pid, "SIGKILL");
    } catch {
      return;
    }
  } else if (alive) {
    return;
  }
  for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    rmSync(join(sessionDir, name), { force: true });
  }
}

export class WhatsAppNative {
  private readonly options: Required<Omit<WhatsAppNativeOptions, "onChange" | "onCaptured" | "noBrowserReason">> &
    Pick<WhatsAppNativeOptions, "onChange" | "onCaptured" | "noBrowserReason">;
  readonly sessionDir: string;

  private state: WhatsAppLinkState = "not_linked";
  private qr: string | null = null;
  private reason: string | null = null;
  private failures = 0;
  private circuitOpen = false;
  private nextRetryAt: number | null = null;
  private linkedAt: number | null = null;
  private updatedAt: number;
  private browser: BrowserResolution | null = null;

  private client: ReadOnlyWhatsAppClient | null = null;
  /** bumps on every launch and teardown; events from older clients are ignored */
  private generation = 0;
  private ready = false;
  private starting: Promise<void> | null = null;
  /** clients torn down whose destroy() has not finished yet */
  private destroys = new Set<{ done: Promise<void>; pid: number | null; settled: boolean }>();
  private retryTimer: unknown = null;
  private probeTimer: unknown = null;
  private startTimer: unknown = null;
  private probing = false;
  private stopped = false;

  constructor(options: WhatsAppNativeOptions) {
    const sessionDir = sessionDirFor(options.authDir, options.clientId);
    this.sessionDir = sessionDir;
    const markerFile = options.markerFile ?? join(dirname(options.authDir), "linked.json");
    this.options = {
      markerFile,
      marker: fileLinkedMarker(markerFile, options.now),
      killProcess: (pid) => process.kill(pid, "SIGKILL"),
      destroyTimeoutMs: 15_000,
      releaseStaleProfile,
      clearSession: (dir) => rmSync(dir, { recursive: true, force: true }),
      timers: realTimers,
      now: Date.now,
      log: (line) => console.log(`whatsapp: ${line}`),
      probeIntervalMs: 30_000,
      probeTimeoutMs: 15_000,
      startTimeoutMs: 180_000,
      loadTimeoutMs: 30_000,
      maxFailures: 5,
      baseDelayMs: 5_000,
      maxDelayMs: 5 * 60_000,
      qrMaxRetries: 5,
      deviceName: "BOS Bot",
      ...options,
    };
    this.updatedAt = this.options.now();
  }

  snapshot(): WhatsAppNativeSnapshot {
    let messageCount = 0;
    try {
      messageCount = this.options.store.count();
    } catch {}
    return {
      state: this.state,
      qr: this.state === "qr_pending" ? this.qr : null,
      reason: this.reason,
      sessionExists: this.saved(),
      browser: this.browser,
      failures: this.failures,
      circuitOpen: this.circuitOpen,
      nextRetryAt: this.nextRetryAt,
      linkedAt: this.state === "linked" ? this.linkedAt : null,
      updatedAt: this.updatedAt,
      messageCount,
    };
  }

  replyTransport() {
    return this.state === "linked" ? this.client?.replies ?? null : null;
  }
  historyTransport() { return this.state === "linked" ? this.client?.history ?? null : null; }

  /** Server boot: resume a saved session without a QR; otherwise stay idle. */
  autoStart(): Promise<void> {
    if (!this.saved()) {
      this.set("not_linked", null);
      return Promise.resolve();
    }
    return this.start();
  }

  /** The tile's Connect. Idempotent while a client is alive or starting. */
  async connect(): Promise<WhatsAppNativeSnapshot> {
    if (this.starting) {
      await this.starting;
      return this.snapshot();
    }
    if (this.client) return this.snapshot();
    this.resetBreaker();
    await this.start();
    return this.snapshot();
  }

  /** The tile's Reconnect / Rescan: drop whatever is there and start over. */
  async reconnect(): Promise<WhatsAppNativeSnapshot> {
    if (this.starting) await this.starting;
    const rescan = this.state === "needs_rescan";
    this.teardown();
    this.resetBreaker();
    if (rescan) {
      // The saved session is the one WhatsApp refused (auth_failure, unpaired,
      // blocked): resuming it would only fail again. Clear BOS's own profile
      // once its browser has closed, so the next start shows a QR code.
      await this.awaitDestroys();
      this.forget();
      try {
        this.options.clearSession(this.sessionDir);
      } catch (error) {
        this.options.log(`could not clear the rejected session: ${message(error)}`);
      }
    }
    await this.start();
    return this.snapshot();
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    this.clearRetry();
    this.teardown();
    await this.awaitDestroys();
  }

  // ── lifecycle ────────────────────────────────────────────────────────

  private start(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.starting) return this.starting;
    if (this.client) return Promise.resolve();
    this.starting = this.launch().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async launch(): Promise<void> {
    this.clearRetry();
    this.browser = this.options.resolveBrowser();
    if (!this.browser) {
      this.circuitOpen = true;
      this.set("disconnected", this.options.noBrowserReason?.() ?? "No Chrome or Chromium was found.");
      return;
    }
    const gen = ++this.generation;
    this.ready = false;
    this.qr = null;
    this.set("linking", null);
    let factory: CreateReadOnlyClient | null;
    try {
      // A previous client's Chromium must be gone before a new one opens the
      // same profile: two browsers on one LocalAuth directory corrupt it.
      await this.awaitDestroys();
      factory = await this.loadFactoryBounded();
    } catch (error) {
      if (gen !== this.generation) return;
      // Missing runtime is a packaging fault, not something a retry fixes.
      this.circuitOpen = true;
      this.set("disconnected", `WhatsApp runtime could not load: ${message(error)}`);
      return;
    }
    if (gen !== this.generation || this.stopped) return;
    if (!factory) {
      // A load that never settles would hold `starting` forever, and with it
      // every Connect/Reconnect. Count it as a failure so backoff retries.
      this.fail(gen, `WhatsApp runtime did not load within ${Math.round(this.options.loadTimeoutMs / 1000)}s.`);
      return;
    }
    try {
      this.options.releaseStaleProfile(this.sessionDir);
    } catch {}
    let client: ReadOnlyWhatsAppClient;
    try {
      client = factory(
        {
          authDir: this.options.authDir,
          clientId: this.options.clientId,
          executablePath: this.browser.path,
          qrMaxRetries: this.options.qrMaxRetries,
          deviceName: this.options.deviceName,
        },
        this.handlersFor(gen),
      );
    } catch (error) {
      this.fail(gen, `could not create the WhatsApp client: ${message(error)}`);
      return;
    }
    this.client = client;
    this.armStartTimer(gen);
    // initialize() covers launching Chromium and loading WhatsApp Web, which
    // can take a while (and never settles on a dead network: the start timer
    // covers that). Callers get the state immediately; events drive the rest.
    void Promise.resolve()
      .then(() => client.initialize())
      .catch((error) => this.fail(gen, `could not start WhatsApp: ${message(error)}`));
  }

  private handlersFor(gen: number): ReadOnlyClientHandlers {
    const live = () => gen === this.generation && !this.stopped;
    return {
      onQr: (qr) => {
        if (!live()) return;
        // WhatsApp asking for a QR means no valid session exists (never
        // linked, or unlinked while BOS was off): stop resuming at boot.
        this.forget();
        this.qr = qr;
        this.armStartTimer(gen);
        this.set("qr_pending", null);
      },
      onAuthenticated: () => {
        if (!live()) return;
        this.qr = null;
        this.armStartTimer(gen);
        this.set("linking", null);
      },
      onAuthFailure: (detail) => {
        if (!live()) return;
        this.fail(gen, `WhatsApp rejected the saved session (${detail}). Scan a new QR code.`, true);
      },
      onReady: () => {
        if (!live()) return;
        this.ready = true;
        this.clearStartTimer();
        this.resetBreaker();
        this.qr = null;
        this.linkedAt = this.options.now();
        try {
          this.options.marker.write();
        } catch (error) {
          this.options.log(`could not record the linked session: ${message(error)}`);
        }
        this.set("linked", null);
        this.goInvisible(gen);
        this.startProbe(gen);
      },
      onDisconnected: (reason) => {
        if (!live()) return;
        if (QR_EXHAUSTED.test(reason)) {
          this.teardown();
          this.set("not_linked", "The QR code expired. Press Connect for a new one.");
          return;
        }
        if (RESCAN_DISCONNECTS.test(reason)) {
          this.fail(gen, "WhatsApp unlinked this device. Scan a new QR code to link it again.", true);
          return;
        }
        this.fail(gen, `WhatsApp disconnected (${reason}).`);
      },
      onStateChange: (state) => {
        if (!live()) return;
        this.applyWaState(gen, state);
      },
      onMessage: (captured) => {
        if (!live()) return;
        try {
          if (this.options.store.insert(captured) && !captured.importedHistory) this.options.onCaptured?.(captured);
        } catch (error) {
          this.options.log(`could not store message: ${message(error)}`);
        }
      },
      onDropped: (reason) => {
        if (!live()) return;
        this.options.log(`dropped a message: ${reason}`);
      },
    };
  }

  private applyWaState(gen: number, state: string): void {
    switch (state.toUpperCase()) {
      case "CONNECTED":
        if (this.ready && this.state !== "linked") {
          // back after a drop within the same client: WhatsApp may have
          // reset presence on the new connection
          this.set("linked", null);
          this.goInvisible(gen);
        }
        return;
      case "OPENING":
      case "PAIRING":
        if (this.ready) this.set("linking", "Reconnecting to WhatsApp…");
        return;
      case "UNPAIRED":
      case "UNPAIRED_IDLE":
        this.fail(gen, "WhatsApp unlinked this device. Scan a new QR code to link it again.", true);
        return;
      case "TOS_BLOCK":
      case "SMB_TOS_BLOCK":
        this.fail(gen, `WhatsApp blocked this linked session (${state}).`, true);
        return;
      case "CONFLICT":
        // Another WhatsApp Web window holds the session. Keep the client: the
        // probe notices when this one is back in charge.
        this.set("disconnected", "WhatsApp is open in another browser window.");
        return;
      case "TIMEOUT":
      case "PROXYBLOCK":
        this.set("disconnected", `WhatsApp is not reachable (${state}).`);
        return;
      case "UNLAUNCHED":
      case "DEPRECATED_VERSION":
        this.fail(gen, `WhatsApp Web stopped (${state}).`);
        return;
      default:
        return;
    }
  }

  /** Best-effort: never throws, never changes state. */
  private goInvisible(gen: number): void {
    const client = this.client;
    if (!client || gen !== this.generation) return;
    void Promise.resolve()
      .then(() => client.goInvisible())
      .catch((error) => this.options.log(`could not set presence to unavailable: ${message(error)}`));
  }

  private startProbe(gen: number): void {
    if (this.probeTimer) this.options.timers.clearInterval(this.probeTimer);
    this.probeTimer = this.options.timers.setInterval(() => void this.probe(gen), this.options.probeIntervalMs);
  }

  /** One liveness check. Public for tests and for an explicit status refresh. */
  async probe(gen = this.generation): Promise<void> {
    const client = this.client;
    if (!client || gen !== this.generation || !this.ready || this.probing) return;
    this.probing = true;
    let timer: unknown = null;
    try {
      const state = await Promise.race([
        client.getState(),
        new Promise<never>((_, reject) => {
          timer = this.options.timers.setTimeout(
            () => reject(new Error(`no answer within ${Math.round(this.options.probeTimeoutMs / 1000)}s`)),
            this.options.probeTimeoutMs,
          );
        }),
      ]);
      if (gen !== this.generation) return;
      if (!state) {
        this.fail(gen, "The WhatsApp page stopped answering.");
        return;
      }
      this.applyWaState(gen, state);
    } catch (error) {
      if (gen === this.generation) this.fail(gen, `The WhatsApp browser is gone (${message(error)}).`);
    } finally {
      if (timer) this.options.timers.clearTimeout(timer);
      this.probing = false;
    }
  }

  private fail(gen: number, reason: string, rescan = false): void {
    if (gen !== this.generation) return;
    this.teardown();
    this.options.log(reason);
    if (rescan) {
      // WhatsApp refused or unlinked it: nothing is saved any more
      this.forget();
      this.set("needs_rescan", reason);
      return;
    }
    this.failures += 1;
    if (!this.saved()) {
      // Nothing saved to resume: a retry would only paint another QR code
      // nobody asked for. The person presses Connect again.
      this.set("disconnected", reason);
      return;
    }
    if (this.failures >= this.options.maxFailures) {
      this.circuitOpen = true;
      this.set("disconnected", `${reason} Stopped retrying after ${this.failures} attempts — press Reconnect.`);
      return;
    }
    const delay = Math.min(this.options.baseDelayMs * 2 ** (this.failures - 1), this.options.maxDelayMs);
    this.nextRetryAt = this.options.now() + delay;
    this.set("disconnected", reason);
    this.retryTimer = this.options.timers.setTimeout(() => {
      this.retryTimer = null;
      this.nextRetryAt = null;
      void this.start();
    }, delay);
  }

  /** Forget the current client and close its browser. Idempotent. */
  private teardown(): void {
    this.generation += 1;
    this.ready = false;
    this.qr = null;
    this.clearStartTimer();
    if (this.probeTimer) this.options.timers.clearInterval(this.probeTimer);
    this.probeTimer = null;
    const client = this.client;
    this.client = null;
    if (client) {
      let pid: number | null = null;
      try {
        pid = client.browserPid();
      } catch {}
      const entry = { done: Promise.resolve(), pid, settled: false };
      entry.done = Promise.resolve()
        .then(() => client.destroy())
        .catch(() => {})
        .finally(() => {
          entry.settled = true;
          this.dropDestroy(entry);
        });
      this.destroys.add(entry);
    }
  }

  // (filter, not Set#delete: the no-send scan bans `.delete(` outright,
  // because Message#delete would delete on the account)
  private dropDestroy(entry: { done: Promise<void>; pid: number | null; settled: boolean }): void {
    this.destroys = new Set([...this.destroys].filter((other) => other !== entry));
  }

  /** Wait for torn-down clients to close their browsers, but never forever:
   * after destroyTimeoutMs, SIGKILL that client's own Chromium (its pid only)
   * so a new client never opens the same profile next to a live one. */
  private async awaitDestroys(): Promise<void> {
    const pending = [...this.destroys];
    if (!pending.length) return;
    let timer: unknown = null;
    const timedOut = await Promise.race([
      Promise.all(pending.map((entry) => entry.done)).then(() => false),
      new Promise<boolean>((resolve) => {
        timer = this.options.timers.setTimeout(() => resolve(true), this.options.destroyTimeoutMs);
      }),
    ]);
    if (timer) this.options.timers.clearTimeout(timer);
    if (!timedOut) return;
    for (const entry of pending) {
      if (entry.settled) continue;
      this.dropDestroy(entry);
      if (entry.pid === null) {
        this.options.log(`a previous WhatsApp client did not close within ${this.options.destroyTimeoutMs / 1000}s and has no browser pid to stop`);
        continue;
      }
      try {
        this.options.killProcess(entry.pid);
        this.options.log(`a previous WhatsApp client did not close within ${this.options.destroyTimeoutMs / 1000}s; stopped its browser (pid ${entry.pid})`);
      } catch (error) {
        this.options.log(`could not stop the previous WhatsApp browser (pid ${entry.pid}): ${message(error)}`);
      }
    }
  }

  /** loadFactory(), or null once loadTimeoutMs passes without an answer */
  private async loadFactoryBounded(): Promise<CreateReadOnlyClient | null> {
    let timer: unknown = null;
    try {
      return await Promise.race([
        this.options.loadFactory(),
        new Promise<null>((resolve) => {
          timer = this.options.timers.setTimeout(() => resolve(null), this.options.loadTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) this.options.timers.clearTimeout(timer);
    }
  }

  private saved(): boolean {
    try {
      return this.options.marker.exists();
    } catch {
      return false;
    }
  }

  private forget(): void {
    try {
      this.options.marker.remove();
    } catch (error) {
      this.options.log(`could not clear the linked-session marker: ${message(error)}`);
    }
  }

  private armStartTimer(gen: number): void {
    this.clearStartTimer();
    this.startTimer = this.options.timers.setTimeout(() => {
      this.startTimer = null;
      if (gen === this.generation && !this.ready) this.fail(gen, "WhatsApp took too long to start.");
    }, this.options.startTimeoutMs);
  }

  private clearStartTimer(): void {
    if (this.startTimer) this.options.timers.clearTimeout(this.startTimer);
    this.startTimer = null;
  }

  private clearRetry(): void {
    if (this.retryTimer) this.options.timers.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.nextRetryAt = null;
  }

  private resetBreaker(): void {
    this.failures = 0;
    this.circuitOpen = false;
    this.clearRetry();
  }

  private set(state: WhatsAppLinkState, reason: string | null): void {
    this.state = state;
    this.reason = reason;
    this.updatedAt = this.options.now();
    try {
      this.options.onChange?.(this.snapshot());
    } catch {}
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Load the read-only client factory: server/whatsapp-wwebjs.ts in a checkout,
 * the separately bundled dist-server/whatsapp-wwebjs.js once packaged. By path,
 * so the main server bundle never inlines whatsapp-web.js or puppeteer. */
export async function loadReadOnlyClientFactory(): Promise<CreateReadOnlyClient> {
  const runtime: { createReadOnlyClient?: unknown } = await import(pathToFileURL(LOADED_RUNTIMES.whatsapp).href);
  if (typeof runtime.createReadOnlyClient !== "function") {
    throw new Error(`${LOADED_RUNTIMES.whatsapp} does not export createReadOnlyClient`);
  }
  return runtime.createReadOnlyClient as CreateReadOnlyClient;
}
