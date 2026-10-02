// Native, read-only WhatsApp capture over a whatsapp-web.js linked device.
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
// Read-only: the client type (whatsapp-types.ts) has no send/reply/seen
// method at all, and messages arrive here as plain records.
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
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
  cacheDir: string;
  loadFactory: () => Promise<CreateReadOnlyClient>;
  resolveBrowser: () => BrowserResolution | null;
  noBrowserReason?: () => string;
  store: { insert(message: CapturedMessage): boolean; count(): number };
  sessionExists?: () => boolean;
  /** frees a profile left locked by a crashed previous run */
  releaseStaleProfile?: (sessionDir: string) => void;
  /** drops a session WhatsApp rejected, so Rescan shows a fresh QR code */
  clearSession?: (sessionDir: string) => void;
  timers?: Timers;
  now?: () => number;
  log?: (line: string) => void;
  onChange?: (snapshot: WhatsAppNativeSnapshot) => void;
  probeIntervalMs?: number;
  probeTimeoutMs?: number;
  /** a start that produces no lifecycle event for this long is a failure */
  startTimeoutMs?: number;
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

function hasSavedSession(sessionDir: string): boolean {
  try {
    return existsSync(sessionDir) && readdirSync(sessionDir).length > 0;
  } catch {
    return false;
  }
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
  private readonly options: Required<Omit<WhatsAppNativeOptions, "onChange" | "noBrowserReason">> &
    Pick<WhatsAppNativeOptions, "onChange" | "noBrowserReason">;
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
  private destroying: Promise<void> = Promise.resolve();
  private retryTimer: unknown = null;
  private probeTimer: unknown = null;
  private startTimer: unknown = null;
  private probing = false;
  private stopped = false;

  constructor(options: WhatsAppNativeOptions) {
    const sessionDir = sessionDirFor(options.authDir, options.clientId);
    this.sessionDir = sessionDir;
    this.options = {
      sessionExists: () => hasSavedSession(sessionDir),
      releaseStaleProfile,
      clearSession: (dir) => rmSync(dir, { recursive: true, force: true }),
      timers: realTimers,
      now: Date.now,
      log: (line) => console.log(`whatsapp: ${line}`),
      probeIntervalMs: 30_000,
      probeTimeoutMs: 15_000,
      startTimeoutMs: 180_000,
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
      sessionExists: this.options.sessionExists(),
      browser: this.browser,
      failures: this.failures,
      circuitOpen: this.circuitOpen,
      nextRetryAt: this.nextRetryAt,
      linkedAt: this.state === "linked" ? this.linkedAt : null,
      updatedAt: this.updatedAt,
      messageCount,
    };
  }

  /** Server boot: resume a saved session without a QR; otherwise stay idle. */
  autoStart(): Promise<void> {
    if (!this.options.sessionExists()) {
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
      await this.destroying;
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
    let cap: unknown = null;
    await Promise.race([
      this.destroying,
      new Promise<void>((resolve) => {
        cap = this.options.timers.setTimeout(resolve, 10_000);
      }),
    ]);
    if (cap) this.options.timers.clearTimeout(cap);
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
    let factory: CreateReadOnlyClient;
    try {
      // A previous client's Chromium must be gone before a new one opens the
      // same profile: two browsers on one LocalAuth directory corrupt it.
      await this.destroying;
      factory = await this.options.loadFactory();
    } catch (error) {
      if (gen !== this.generation) return;
      // Missing runtime is a packaging fault, not something a retry fixes.
      this.circuitOpen = true;
      this.set("disconnected", `WhatsApp runtime could not load: ${message(error)}`);
      return;
    }
    if (gen !== this.generation || this.stopped) return;
    try {
      this.options.releaseStaleProfile(this.sessionDir);
    } catch {}
    let client: ReadOnlyWhatsAppClient;
    try {
      client = factory(
        {
          authDir: this.options.authDir,
          clientId: this.options.clientId,
          cacheDir: this.options.cacheDir,
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
        this.set("linked", null);
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
          this.options.store.insert(captured);
        } catch (error) {
          this.options.log(`could not store message: ${message(error)}`);
        }
      },
    };
  }

  private applyWaState(gen: number, state: string): void {
    switch (state.toUpperCase()) {
      case "CONNECTED":
        if (this.ready) this.set("linked", null);
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
      this.set("needs_rescan", reason);
      return;
    }
    this.failures += 1;
    if (!this.options.sessionExists()) {
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
      const previous = this.destroying;
      this.destroying = previous.then(() => client.destroy()).catch(() => {});
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
