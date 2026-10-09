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
  push(actorId: string, title: string, body: string, target: PushTarget, ringId: string): Promise<void>;
  now?: () => number;
}

/** One synchronous reservation precedes both transports. Persist it before
 * publishing so a restart or an overlapping request cannot ring twice. */
export class VoiceRings {
  private readonly lastRing = new Map<string, number>();
  private readonly options: VoiceRingOptions;
  constructor(options: VoiceRingOptions) {
    this.options = options;
    if (!existsSync(options.file)) return;
    const data = z.object({ version: z.literal(1), rings: z.array(z.tuple([id, z.number().finite().nonnegative()])) }).parse(JSON.parse(readFileSync(options.file, "utf8")));
    for (const [botId, at] of data.rings) this.lastRing.set(botId, at);
  }

  ring(input: { botId: string; threadId: string; reason: string }, botName: string): VoiceRingData {
    const at = (this.options.now ?? Date.now)();
    const previous = this.lastRing.get(input.botId);
    if (previous !== undefined && at - previous < WINDOW_MS) {
      throw new VoiceRingRateLimit(Math.ceil((previous + WINDOW_MS - at) / 1000));
    }
    const next = new Map([...this.lastRing].filter(([, value]) => at - value < WINDOW_MS));
    next.set(input.botId, at);
    mkdirSync(dirname(this.options.file), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.options.file, JSON.stringify({ version: 1, rings: [...next] }), { mode: 0o600 });
    this.lastRing.clear();
    for (const [botId, value] of next) this.lastRing.set(botId, value);
    const ring: VoiceRingData = { type: "voice_ring", ringId: randomUUID(), ...input };
    this.options.emit({ kind: "voice_ring", ...ring });
    void this.options.push(this.options.ownerId, `${botName} is calling`, ring.reason, { ...ring, botName }, ring.ringId)
      .catch(error => console.warn(`voice ring push failed: ${error instanceof Error ? error.message : "unknown failure"}`));
    return ring;
  }
}
