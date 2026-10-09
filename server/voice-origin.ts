// Messages that come from a live voice call.
//
// The phone's send to a bot can say it came from a call:
// `origin: { kind: "voice_call", callId, job? }`. The server keeps that on
// the user message and on the turn it starts, and does two things with it:
// the model is told, in one line, that its answer will be read out; and when
// that turn settles the owner gets a push whatever the bot's notifications
// switch says, because the caller may have hung up in the meantime.
import type { VoiceCallOrigin, WireMessage as Message } from "../shared/wire.ts";

export type { VoiceCallOrigin } from "../shared/wire.ts";

export const VOICE_CALL_HINT =
  "sent from a live voice call: lead with the outcome in one or two plain spoken sentences, details after.";
export const MAX_CALL_ID_CHARS = 128;
export const MAX_VOICE_JOB_CHARS = 2000;

/** Validate a send's `origin`. Absent (or null) is an ordinary send. Unknown
 * keys are dropped, so a newer phone adding a field is not refused. */
export function parseMessageOrigin(value: unknown): { ok: true; origin?: VoiceCallOrigin } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true };
  if (typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "origin must be an object" };
  const input = value as Record<string, unknown>;
  if (input.kind !== "voice_call") return { ok: false, error: "origin.kind must be voice_call" };
  const callId = input.callId;
  if (typeof callId !== "string" || !callId.trim() || callId.length > MAX_CALL_ID_CHARS) {
    return { ok: false, error: `origin.callId must be a non-empty string of at most ${MAX_CALL_ID_CHARS} characters` };
  }
  if (input.job !== undefined && input.job !== null && (typeof input.job !== "string" || input.job.length > MAX_VOICE_JOB_CHARS)) {
    return { ok: false, error: `origin.job must be a string of at most ${MAX_VOICE_JOB_CHARS} characters` };
  }
  const job = typeof input.job === "string" && input.job.trim() ? input.job : undefined;
  return { ok: true, origin: { kind: "voice_call", callId, ...(job ? { job } : {}) } };
}

/** The voice origin a turn runs under: the newest voice-call line among the
 * user messages it delivers (a drained queue can carry several). */
export function turnVoiceOrigin(messages: ReadonlyArray<Pick<Message, "origin"> | undefined>): VoiceCallOrigin | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const origin = messages[i]?.origin;
    if (origin?.kind === "voice_call") return origin;
  }
  return undefined;
}

/** Model-facing text only: the transcript keeps the caller's own words. */
export function withVoiceCallHint(text: string, origin: VoiceCallOrigin | undefined): string {
  return origin ? `${VOICE_CALL_HINT}\n${text}` : text;
}
