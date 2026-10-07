// Realtime voice call — the wire protocol, as pure functions.
//
// This is a faithful port of Grok Bot desktop's realtime call ("Sand"),
// reverse-engineered from its renderer bundle (plans/grok-voice/protocol.md).
// The wire is xAI realtime (OpenAI-realtime-shaped) plus one extension,
// `async_update.add`, which lets a finished job ride into the call without
// the client asking for a response.
//
// Nothing in this file touches a socket, an AudioContext or React, so every
// frame, every parse and every piece of timing math is unit-tested directly.

/** Capture context rate, playback rate and wire rate are all one number. */
export const SAMPLE_RATE = 24_000;
/** ScriptProcessor buffer: 2048 mono frames = 85.3 ms per append. */
export const FRAME_SIZE = 2048;
export const AUDIO_FORMAT = "audio/pcm";
export const TRANSCRIBE_MODEL = "grok-transcribe";
export const DEFAULT_MODEL = "grok-voice-3.0";
/** Only this origin is ever dialled, whatever the server returns. */
export const DIALABLE_ORIGIN = "wss://api.x.ai/";

/** Mic permission prompt: give up after 30 s (`microphone_prompt_unanswered`). */
export const MIC_PROMPT_TIMEOUT_MS = 30_000;
/** end_the_call waits at most this long for the goodbye to finish playing. */
export const GOODBYE_MAX_MS = 15_000;
/** The greeting is held this long for the caller to speak first. */
export const GREETING_GRACE_MS = 15_000;
/** One reconnect dial must reach session.created within this. */
export const DIAL_TIMEOUT_MS = 15_000;

export const RECONNECT = {
  maxAttempts: 20,
  initialDelayMs: 1_000,
  maxDelayMs: 10_000,
  factor: 1.2,
} as const;

/** Close codes with a meaning of their own. */
export const CLOSE_NORMAL = 1000;
export const CLOSE_POLICY = 1008;
/** The app's own code for a socket dropped in favour of a redial. */
export const CLOSE_SUPERSEDED = 4001;

export const SPEEDS = [0.75, 1, 1.25, 1.5, 2] as const;
export const DEFAULT_SPEED = 1;
export const AUTO_LANGUAGE = "auto";
export const DEFAULT_VOICE = "liora";

/** Chime: sine notes, 6 ms attack, (1 - t/dur)^2 decay, gain 0.16. */
export const CHIME_GAIN = 0.16;
export const CHIME_ATTACK_S = 0.006;
export const CONNECT_CHIME = [
  { hz: 659.25, ms: 90 },
  { hz: 987.77, ms: 150 },
] as const;
export const HANGUP_CHIME = [
  { hz: 987.77, ms: 90 },
  { hz: 659.25, ms: 150 },
] as const;

// ── shapes the server hands us (POST /api/voice/call) ────────────────────

export interface VoiceCallCredential {
  clientSecret: string;
  expiresAt: number;
  model: string;
  websocketUrl: string;
}

export interface VoiceCallTool {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface VoiceCallPlan {
  instructions: string;
  greeting: { direction: string };
  tools: VoiceCallTool[];
  receiptTurn: string;
  maxRequestChars: number;
}

export interface VoiceCallOptions {
  voices: string[];
  speeds: number[];
  languages: string[];
}

export interface VoiceCallTicket {
  credential: VoiceCallCredential;
  plan: VoiceCallPlan;
  options: VoiceCallOptions;
}

export interface VoiceSettings {
  voice: string;
  speed: number;
  language: string;
}

// ── dialling ─────────────────────────────────────────────────────────────

export function isDialableUrl(url: string): boolean {
  return typeof url === "string" && url.startsWith(DIALABLE_ORIGIN);
}

/** `wss://api.x.ai/v1/realtime?model=…[&conversation_id=…]`. Throws on any
 * other host: the secret must never be offered to a different origin. */
export function realtimeUrl(credential: VoiceCallCredential, conversationId?: string | null): string {
  if (!isDialableUrl(credential.websocketUrl)) {
    throw new Error(`Refusing to dial ${credential.websocketUrl}: voice calls only connect to api.x.ai`);
  }
  const url = new URL(credential.websocketUrl);
  url.searchParams.set("model", credential.model || DEFAULT_MODEL);
  if (conversationId) url.searchParams.set("conversation_id", conversationId);
  return url.toString();
}

/** Auth rides the websocket subprotocol; there is no Authorization header. */
export function realtimeProtocols(credential: VoiceCallCredential): string[] {
  return [`xai-client-secret.${credential.clientSecret}`];
}

/** First retry is immediate; later ones back off 1 s * 1.2^(n-1), max 10 s.
 * `attempt` is 0-based. Returns null once the attempts are spent. */
export function reconnectDelayMs(attempt: number): number | null {
  if (attempt >= RECONNECT.maxAttempts) return null;
  if (attempt <= 0) return 0;
  return Math.min(
    RECONNECT.maxDelayMs,
    Math.round(RECONNECT.initialDelayMs * RECONNECT.factor ** (attempt - 1)),
  );
}

/** Snap any speed to the nearest offered value. */
export function snapSpeed(speed: number, speeds: readonly number[] = SPEEDS): number {
  if (!Number.isFinite(speed) || speeds.length === 0) return DEFAULT_SPEED;
  let best = speeds[0];
  for (const s of speeds) if (Math.abs(s - speed) < Math.abs(best - speed)) best = s;
  return best;
}

// ── client → server frames ───────────────────────────────────────────────

export function sessionUpdateFrame(
  plan: Pick<VoiceCallPlan, "instructions" | "tools">,
  settings: VoiceSettings,
  reconnect: boolean,
): string {
  const transcription: Record<string, string> = { model: TRANSCRIBE_MODEL };
  if (settings.language && settings.language !== AUTO_LANGUAGE) transcription.language_hint = settings.language;
  return JSON.stringify({
    type: "session.update",
    session: {
      ...(settings.voice ? { voice: settings.voice } : {}),
      ...(reconnect ? { keep_context: false } : {}),
      instructions: plan.instructions,
      turn_detection: { type: "server_vad" },
      audio: {
        input: { format: { type: AUDIO_FORMAT, rate: SAMPLE_RATE }, transcription },
        output: { format: { type: AUDIO_FORMAT, rate: SAMPLE_RATE }, speed: settings.speed },
      },
      tools: plan.tools,
    },
  });
}

export function appendFrame(base64Pcm16: string): string {
  return JSON.stringify({ type: "input_audio_buffer.append", audio: base64Pcm16 });
}

export function responseCreateFrame(instructions?: string | null): string {
  return JSON.stringify(
    instructions ? { type: "response.create", response: { instructions } } : { type: "response.create" },
  );
}

export function functionOutputFrame(callId: string, output: unknown): string {
  return JSON.stringify({
    type: "conversation.item.create",
    item: {
      type: "function_call_output",
      call_id: callId,
      output: typeof output === "string" ? output : JSON.stringify(output),
    },
  });
}

/** Truncate an assistant item to what the caller actually heard. */
export function truncateFrame(itemId: string, contentIndex: number, audioEndMs: number): string {
  return JSON.stringify({
    type: "conversation.item.truncate",
    item_id: itemId,
    content_index: contentIndex,
    audio_end_ms: Math.max(0, Math.round(audioEndMs)),
  });
}

/** A finished job rides into the call; the server starts its own response. */
export function workLandedFrame(eventId: string, text: string, timestampMs: number): string {
  return JSON.stringify({
    type: "async_update.add",
    event_id: eventId,
    async_update: {
      topic: "work_landed",
      payload: [{ message: { type: "text", content: text }, timestampMs }],
    },
  });
}

export interface SettledTurn {
  speaker: "user" | "assistant";
  text: string;
}

/** Reconnect replay: one message item per settled, non-empty turn. */
export function historyFrames(turns: readonly SettledTurn[]): string[] {
  return turns
    .filter((t) => t.text.trim().length > 0)
    .map((t) =>
      JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: t.speaker,
          content: [{ type: t.speaker === "user" ? "input_text" : "output_text", text: t.text }],
        },
      }),
    );
}

// ── timing math ──────────────────────────────────────────────────────────

/** A scheduled stretch of one assistant item's audio, in context seconds. */
export interface AudioSpan {
  itemId: string;
  contentIndex: number;
  startsAt: number;
  endsAt: number;
}

/** How much of a span the caller heard, in ms (what `audio_end_ms` wants). */
export function heardMs(span: Pick<AudioSpan, "startsAt">, currentTime: number): number {
  return Math.max(0, Math.round((currentTime - span.startsAt) * 1000));
}

/** Spans still playing at `currentTime` get a truncate; fully played ones do not. */
export function truncationsFor(spans: Iterable<AudioSpan>, currentTime: number): Array<{
  itemId: string;
  contentIndex: number;
  audioEndMs: number;
}> {
  const cuts: Array<{ itemId: string; contentIndex: number; audioEndMs: number }> = [];
  for (const span of spans) {
    if (span.endsAt <= currentTime) continue;
    cuts.push({ itemId: span.itemId, contentIndex: span.contentIndex, audioEndMs: heardMs(span, currentTime) });
  }
  return cuts;
}

// ── server → client events ───────────────────────────────────────────────

export type ServerEvent =
  | { kind: "session_ready" }
  | { kind: "conversation_created"; id: string }
  | { kind: "response_created"; trigger: string | null }
  | { kind: "response_done"; cancelled: boolean }
  | { kind: "audio_delta"; itemId: string; contentIndex: number; delta: string }
  | { kind: "speech_started"; itemId: string | null }
  | { kind: "speech_stopped" }
  | { kind: "item_added"; itemId: string | null; role: string | null }
  | { kind: "user_transcript"; itemId: string; text: string; final: boolean; replace: boolean }
  | { kind: "user_transcript_failed"; itemId: string }
  | { kind: "assistant_transcript_delta"; itemId: string; delta: string }
  | { kind: "assistant_transcript_done"; itemId: string; text: string }
  | { kind: "item_truncated"; itemId: string; text: string | null }
  | { kind: "function_call"; callId: string; name: string; arguments: string }
  | { kind: "error"; type: string | null; code: string | null; message: string }
  | { kind: "unsupported"; type: string };

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown, fallback = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

/** Parse one text frame into a routed event. Binary frames and garbage
 * become `unsupported` and are ignored by the engine. */
export function parseServerEvent(data: unknown): ServerEvent {
  if (typeof data !== "string") return { kind: "unsupported", type: "binary" };
  let raw: Record<string, any>;
  try {
    const parsed = JSON.parse(data);
    if (!parsed || typeof parsed !== "object") return { kind: "unsupported", type: "invalid" };
    raw = parsed;
  } catch {
    return { kind: "unsupported", type: "invalid" };
  }
  const type = str(raw.type) ?? "";
  switch (type) {
    case "session.created":
    case "session.updated":
      return { kind: "session_ready" };
    case "conversation.created": {
      const id = str(raw.conversation?.id);
      return id ? { kind: "conversation_created", id } : { kind: "unsupported", type };
    }
    case "response.created":
      return { kind: "response_created", trigger: str(raw.response?.metadata?.trigger) };
    case "response.done":
      return { kind: "response_done", cancelled: raw.response?.status === "cancelled" };
    case "response.cancelled":
      return { kind: "response_done", cancelled: true };
    case "response.audio.delta":
    case "response.output_audio.delta": {
      const delta = str(raw.delta);
      const itemId = str(raw.item_id);
      if (!delta || !itemId) return { kind: "unsupported", type };
      return { kind: "audio_delta", itemId, contentIndex: num(raw.content_index), delta };
    }
    case "input_audio_buffer.speech_started":
      return { kind: "speech_started", itemId: str(raw.item_id) };
    case "input_audio_buffer.speech_stopped":
      return { kind: "speech_stopped" };
    case "conversation.item.added":
    case "conversation.item.created":
      return { kind: "item_added", itemId: str(raw.item?.id), role: str(raw.item?.role) };
    case "conversation.item.input_audio_transcription.completed":
    case "conversation.item.input_audio_transcription.updated": {
      const itemId = str(raw.item_id);
      if (!itemId) return { kind: "unsupported", type };
      const full = str(raw.transcript);
      const text = full ?? str(raw.delta) ?? str(raw.text) ?? "";
      return {
        kind: "user_transcript",
        itemId,
        text,
        final: type.endsWith(".completed"),
        replace: full !== null,
      };
    }
    case "conversation.item.input_audio_transcription.delta": {
      const itemId = str(raw.item_id);
      if (!itemId) return { kind: "unsupported", type };
      return { kind: "user_transcript", itemId, text: str(raw.delta) ?? "", final: false, replace: false };
    }
    case "conversation.item.input_audio_transcription.failed": {
      const itemId = str(raw.item_id);
      return itemId ? { kind: "user_transcript_failed", itemId } : { kind: "unsupported", type };
    }
    case "response.audio_transcript.delta":
    case "response.output_audio_transcript.delta": {
      const itemId = str(raw.item_id);
      if (!itemId) return { kind: "unsupported", type };
      return { kind: "assistant_transcript_delta", itemId, delta: str(raw.delta) ?? "" };
    }
    case "response.audio_transcript.done":
    case "response.output_audio_transcript.done": {
      const itemId = str(raw.item_id);
      if (!itemId) return { kind: "unsupported", type };
      return { kind: "assistant_transcript_done", itemId, text: str(raw.transcript) ?? "" };
    }
    case "conversation.item.truncated": {
      const itemId = str(raw.item_id);
      if (!itemId) return { kind: "unsupported", type };
      const text = str(raw.transcript) ?? str(raw.item?.content?.[0]?.transcript) ?? null;
      return { kind: "item_truncated", itemId, text };
    }
    case "response.function_call_arguments.done": {
      const callId = str(raw.call_id);
      const name = str(raw.name);
      if (!callId || !name) return { kind: "unsupported", type };
      return { kind: "function_call", callId, name, arguments: str(raw.arguments) ?? "{}" };
    }
    case "error":
      return {
        kind: "error",
        type: str(raw.error?.type),
        code: str(raw.error?.code),
        message: str(raw.error?.message) ?? "The voice service reported an error.",
      };
    default:
      return { kind: "unsupported", type };
  }
}

/** Tool arguments arrive as a JSON string; anything unreadable is `{}`. */
export function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** send_task's request check. Overlong requests are rejected, never cut. */
export function validateTaskRequest(
  args: Record<string, unknown>,
  maxChars: number,
): { ok: true; request: string } | { ok: false; error: string } {
  const request = typeof args.request === "string" ? args.request.trim() : "";
  if (!request) {
    return { ok: false, error: "The request was empty. Say what the job is, then call send_task again with it." };
  }
  if (request.length > maxChars) {
    return {
      ok: false,
      error: `The request was ${request.length} characters; the limit is ${maxChars}. Rewrite it shorter, keeping every constraint, and call send_task again.`,
    };
  }
  return { ok: true, request };
}

/** The line, as the response gate reads it. */
export type LineState = "dead" | "callers" | "busy" | "free";

export function readTheLine(line: {
  socketIsWritable: boolean;
  callerIsSpeaking: boolean;
  responseIsInFlight: boolean;
  speakerIsBusy: boolean;
}): LineState {
  if (!line.socketIsWritable) return "dead";
  if (line.callerIsSpeaking) return "callers";
  return line.responseIsInFlight || line.speakerIsBusy ? "busy" : "free";
}

/** m:ss, or h:mm:ss past an hour. */
export function formatCallDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
