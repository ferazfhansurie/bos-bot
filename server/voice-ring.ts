import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";
import type { PushTarget } from "./apns-push.ts";

const id = z.string().regex(/^[\w-]{1,128}$/);
export const voiceRingInput = z.object({
  botId: id,
  threadId: id.optional(),
  reason: z.string().trim().min(1).max(500),
}).strict();

export interface VoiceRingData {
  type: "voice_ring";
  ringId: string;
  botId: string;
  threadId: string;
  reason: string;
  /** "job_done": a voice call-back (server/voice-callback.ts). The phone
   * opens the answered call with the result instead of "why I rang". */
  purpose?: "job_done";
}

const WINDOW_MS = 10 * 60_000;
export class VoiceRingRateLimit extends Error {
  readonly status = 429;
  readonly retryAfter: number;
  constructor(retryAfter: number) {
    super(`This bot already rang within ten minutes. Try again in ${retryAfter} seconds.`);
    this.retryAfter = retryAfter;
  }
}

interface VoiceRingOptions {
  file: string;
  ownerId: string;
  emit(frame: Record<string, unknown>): void;
  /** `skipVoip`: true for a push session whose app showed the ring itself. */
  push(actorId: string, title: string, body: string, target: PushTarget, ringId: string,
    skipVoip: (sessionId: string) => boolean): Promise<void>;
  /** The owner's push sessions that have a live event stream right now. */
  watching?: () => Iterable<string>;
  ackWindowMs?: number;
  now?: () => number;
}

/** How long a phone with a live stream gets to say it showed the ring before
 * CallKit rings it anyway. A stream is not proof the app is on screen: it
 * lingers after backgrounding, a dead cellular socket stays listed until a
 * write fails, and a live call keeps it up (2026-10-10: two rings reached
 * nothing because of it). */
const ACK_WINDOW_MS = 2_000;

/** One synchronous reservation precedes both transports. Persist it before
 * publishing so a restart or an overlapping request cannot ring twice. */
export class VoiceRings {
  private readonly lastRing = new Map<string, number>();
  private readonly pending = new Map<string, { waiting: Set<string>; acked: Set<string>; fire(): void }>();
  private readonly options: VoiceRingOptions;
  constructor(options: VoiceRingOptions) {
    this.options = options;
    if (!existsSync(options.file)) return;
    const data = z.object({ version: z.literal(1), rings: z.array(z.tuple([id, z.number().finite().nonnegative()])) }).parse(JSON.parse(readFileSync(options.file, "utf8")));
    for (const [botId, at] of data.rings) this.lastRing.set(botId, at);
  }

  /** A call-back (`purpose: "job_done"`) skips the ten-minute window: it
   * is one ring per settled batch of work the owner asked for, never a
   * bot's own choice. It still counts against the bot's next ring_owner. */
  ring(input: { botId: string; threadId: string; reason: string; purpose?: "job_done" }, botName: string): VoiceRingData {
    const at = (this.options.now ?? Date.now)();
    const previous = this.lastRing.get(input.botId);
    if (!input.purpose && previous !== undefined && at - previous < WINDOW_MS) {
      throw new VoiceRingRateLimit(Math.ceil((previous + WINDOW_MS - at) / 1000));
    }
    const next = new Map([...this.lastRing].filter(([, value]) => at - value < WINDOW_MS));
    next.set(input.botId, at);
    mkdirSync(dirname(this.options.file), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.options.file, JSON.stringify({ version: 1, rings: [...next] }), { mode: 0o600 });
    this.lastRing.clear();
    for (const [botId, value] of next) this.lastRing.set(botId, value);
    const ring: VoiceRingData = { type: "voice_ring", ringId: randomUUID(), ...input };
    // The stream goes first: an app that shows its ring screen acks it, and
    // only that session skips CallKit. Every other device, and any that stays
    // silent past the window, gets the VoIP push as before.
    const waiting = new Set(this.options.watching?.() ?? []);
    const acked = new Set<string>();
    const send = () => void this.options.push(this.options.ownerId, `${botName} is calling`, ring.reason, { ...ring, botName }, ring.ringId,
      session => acked.has(session))
      .catch(error => console.warn(`voice ring push failed: ${error instanceof Error ? error.message : "unknown failure"}`));
    this.options.emit({ kind: "voice_ring", ...ring, inApp: true });
    if (!waiting.size) { send(); return ring; }
    const fire = () => {
      if (!this.pending.delete(ring.ringId)) return;
      clearTimeout(timer);
      send();
    };
    const timer = setTimeout(fire, this.options.ackWindowMs ?? ACK_WINDOW_MS);
    timer.unref?.();
    this.pending.set(ring.ringId, { waiting, acked, fire });
    return ring;
  }

  /** A phone showed this ring on screen. False once the push has gone. */
  ack(ringId: string, sessionId: string): boolean {
    const entry = this.pending.get(ringId);
    if (!entry) return false;
    entry.acked.add(sessionId);
    if ([...entry.waiting].every(session => entry.acked.has(session))) entry.fire();
    return true;
  }
}
