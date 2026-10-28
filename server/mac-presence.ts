// Is the person at this Mac right now?
//
// bos bot 3.0 hands a working bot to the phone's lock screen once the person
// has walked away from the Mac, and back when they return. The signal is the
// HID idle clock (keyboard, mouse, trackpad): a few quiet minutes means they
// left. Read with `ioreg`, so nothing in electron/ has to report it.
//
// Off a Mac, or when ioreg cannot be read, the answer is "unknown" and
// callers keep today's behaviour (the phone always gets the island).
import { execFile } from "node:child_process";

/** Quiet this long and the person has left the Mac. */
export const AWAY_AFTER_MS = 3 * 60_000;
const REFRESH_MS = 10_000;

/** HIDIdleTime is nanoseconds since the last input event. */
export function parseHidIdleMs(ioreg: string): number | undefined {
  const match = /"HIDIdleTime"\s*=\s*(\d+)/.exec(ioreg);
  if (!match) return undefined;
  const ns = Number(match[1]);
  return Number.isFinite(ns) ? ns / 1_000_000 : undefined;
}

export class MacPresence {
  private idleMs: number | undefined;
  private readAt = 0;
  private reading = false;
  private readonly read: () => Promise<string>;
  private readonly now: () => number;
  private readonly mac: boolean;

  constructor(opts: { read?: () => Promise<string>; now?: () => number } = {}) {
    this.read = opts.read ?? (() => new Promise((resolve, reject) =>
      execFile("/usr/sbin/ioreg", ["-c", "IOHIDSystem", "-d", "4"], { timeout: 2_000, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout) => error ? reject(error) : resolve(stdout))));
    this.now = opts.now ?? Date.now;
    this.mac = opts.read ? true : process.platform === "darwin";
  }

  /** true at the Mac, false away, undefined when not known. Never blocks:
   * it answers from the last reading and refreshes in the background. */
  present(): boolean | undefined {
    if (!this.mac) return undefined;
    const now = this.now();
    if (!this.reading && now - this.readAt >= REFRESH_MS) void this.refresh();
    if (this.idleMs === undefined || now - this.readAt > 3 * REFRESH_MS) return undefined;
    return this.idleMs + (now - this.readAt) < AWAY_AFTER_MS;
  }

  async refresh(): Promise<void> {
    this.reading = true;
    try {
      this.idleMs = parseHidIdleMs(await this.read());
    } catch {
      this.idleMs = undefined;
    } finally {
      this.readAt = this.now();
      this.reading = false;
    }
  }
}
