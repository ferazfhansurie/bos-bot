import { describe, expect, it } from "vitest";

import {
  formatCallDuration,
  heardMs,
  historyFrames,
  parseServerEvent,
  readTheLine,
  realtimeProtocols,
  realtimeUrl,
  reconnectDelayMs,
  responseCreateFrame,
  sessionUpdateFrame,
  snapSpeed,
  truncateFrame,
  truncationsFor,
  validateTaskRequest,
  workLandedFrame,
} from "./protocol";
import { renderChime } from "./chime";

const credential = {
  clientSecret: "sek",
  expiresAt: 0,
  model: "grok-voice-3.0",
  websocketUrl: "wss://api.x.ai/v1/realtime",
};
const plan = { instructions: "be brief", tools: [{ type: "function" as const, name: "stay_silent", description: "d", parameters: {} }] };

describe("dialling", () => {
  it("adds the model, and conversation_id only on reconnect", () => {
    expect(realtimeUrl(credential)).toBe("wss://api.x.ai/v1/realtime?model=grok-voice-3.0");
    expect(realtimeUrl(credential, "conv_1")).toBe("wss://api.x.ai/v1/realtime?model=grok-voice-3.0&conversation_id=conv_1");
    expect(realtimeProtocols(credential)).toEqual(["xai-client-secret.sek"]);
  });

  it("refuses any host but api.x.ai", () => {
    expect(() => realtimeUrl({ ...credential, websocketUrl: "wss://evil.example/v1/realtime" })).toThrow(/api\.x\.ai/);
    expect(() => realtimeUrl({ ...credential, websocketUrl: "wss://api.x.ai.evil.example/" })).toThrow();
  });
});

describe("reconnect backoff", () => {
  it("retries at once, then 1s * 1.2^n capped at 10s, for 20 attempts", () => {
    expect(reconnectDelayMs(0)).toBe(0);
    expect(reconnectDelayMs(1)).toBe(1000);
    expect(reconnectDelayMs(2)).toBe(1200);
    expect(reconnectDelayMs(3)).toBe(1440);
    expect(reconnectDelayMs(10)).toBe(Math.round(1000 * 1.2 ** 9));
    expect(reconnectDelayMs(14)).toBe(10_000);
    expect(reconnectDelayMs(19)).toBe(10_000);
    expect(reconnectDelayMs(20)).toBeNull();
  });

  it("never exceeds the cap or goes backwards", () => {
    let previous = -1;
    for (let attempt = 0; attempt < 20; attempt++) {
      const delay = reconnectDelayMs(attempt)!;
      expect(delay).toBeGreaterThanOrEqual(previous);
      expect(delay).toBeLessThanOrEqual(10_000);
      previous = delay;
    }
  });
});

describe("session.update", () => {
  it("matches the Grok Bot frame", () => {
    const frame = JSON.parse(sessionUpdateFrame(plan, { voice: "eve", speed: 1, language: "ms" }, false));
    expect(frame).toEqual({
      type: "session.update",
      session: {
        voice: "eve",
        instructions: "be brief",
        turn_detection: { type: "server_vad" },
        audio: {
          input: { format: { type: "audio/pcm", rate: 24000 }, transcription: { model: "grok-transcribe", language_hint: "ms" } },
          output: { format: { type: "audio/pcm", rate: 24000 }, speed: 1 },
        },
        tools: plan.tools,
      },
    });
  });

  it("omits the language hint for auto, and the voice when there is none", () => {
    const frame = JSON.parse(sessionUpdateFrame(plan, { voice: "", speed: 1.5, language: "auto" }, false));
    expect(frame.session.voice).toBeUndefined();
    expect(frame.session.audio.input.transcription).toEqual({ model: "grok-transcribe" });
    expect(frame.session.audio.output.speed).toBe(1.5);
    expect("keep_context" in frame.session).toBe(false);
  });

  it("sets keep_context false only on reconnect", () => {
    expect(JSON.parse(sessionUpdateFrame(plan, { voice: "eve", speed: 1, language: "auto" }, true)).session.keep_context).toBe(false);
  });
});

describe("client frames", () => {
  it("builds response.create with and without instructions", () => {
    expect(JSON.parse(responseCreateFrame())).toEqual({ type: "response.create" });
    expect(JSON.parse(responseCreateFrame("say hi"))).toEqual({ type: "response.create", response: { instructions: "say hi" } });
  });

  it("builds async_update.add work_landed", () => {
    expect(JSON.parse(workLandedFrame("e1", "done", 42))).toEqual({
      type: "async_update.add",
      event_id: "e1",
      async_update: { topic: "work_landed", payload: [{ message: { type: "text", content: "done" }, timestampMs: 42 }] },
    });
  });

  it("replays only non-empty settled turns with the right content type", () => {
    const frames = historyFrames([
      { speaker: "user", text: "hello" },
      { speaker: "assistant", text: "  " },
      { speaker: "assistant", text: "hi there" },
    ]).map((f) => JSON.parse(f));
    expect(frames).toEqual([
      { type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] } },
      { type: "conversation.item.create", item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi there" }] } },
    ]);
  });
});

describe("truncate math", () => {
  it("rounds heard milliseconds and never goes negative", () => {
    expect(heardMs({ startsAt: 1.0 }, 1.2346)).toBe(235);
    expect(heardMs({ startsAt: 2.0 }, 1.5)).toBe(0);
    expect(JSON.parse(truncateFrame("item_1", 0, -12.4))).toEqual({
      type: "conversation.item.truncate",
      item_id: "item_1",
      content_index: 0,
      audio_end_ms: 0,
    });
    expect(JSON.parse(truncateFrame("item_1", 0, 812.6)).audio_end_ms).toBe(813);
  });

  it("cuts only spans still playing", () => {
    const cuts = truncationsFor(
      [
        { itemId: "done", contentIndex: 0, startsAt: 0, endsAt: 1 },
        { itemId: "playing", contentIndex: 0, startsAt: 1, endsAt: 3 },
        { itemId: "queued", contentIndex: 1, startsAt: 3, endsAt: 4 },
      ],
      2,
    );
    expect(cuts).toEqual([
      { itemId: "playing", contentIndex: 0, audioEndMs: 1000 },
      { itemId: "queued", contentIndex: 1, audioEndMs: 0 },
    ]);
  });
});

describe("parseServerEvent", () => {
  const p = (value: unknown) => parseServerEvent(JSON.stringify(value));

  it("routes session and conversation events", () => {
    expect(p({ type: "session.created" })).toEqual({ kind: "session_ready" });
    expect(p({ type: "session.updated" })).toEqual({ kind: "session_ready" });
    expect(p({ type: "conversation.created", conversation: { id: "c1" } })).toEqual({ kind: "conversation_created", id: "c1" });
  });

  it("routes responses with their trigger", () => {
    expect(p({ type: "response.created", response: { metadata: { trigger: "async_update" } } })).toEqual({
      kind: "response_created",
      trigger: "async_update",
    });
    expect(p({ type: "response.done", response: { status: "completed" } })).toEqual({ kind: "response_done", cancelled: false });
    expect(p({ type: "response.cancelled" })).toEqual({ kind: "response_done", cancelled: true });
  });

  it("accepts both audio delta aliases", () => {
    for (const type of ["response.audio.delta", "response.output_audio.delta"]) {
      expect(p({ type, delta: "AAA=", item_id: "i", content_index: 1 })).toEqual({
        kind: "audio_delta",
        itemId: "i",
        contentIndex: 1,
        delta: "AAA=",
      });
    }
  });

  it("routes VAD, transcripts, truncation, tools and errors", () => {
    expect(p({ type: "input_audio_buffer.speech_started", item_id: "u1" })).toEqual({ kind: "speech_started", itemId: "u1" });
    expect(p({ type: "input_audio_buffer.speech_stopped" })).toEqual({ kind: "speech_stopped" });
    expect(p({ type: "conversation.item.input_audio_transcription.completed", item_id: "u1", transcript: "hey" })).toEqual({
      kind: "user_transcript",
      itemId: "u1",
      text: "hey",
      final: true,
      replace: true,
    });
    expect(p({ type: "conversation.item.input_audio_transcription.failed", item_id: "u1" })).toEqual({
      kind: "user_transcript_failed",
      itemId: "u1",
    });
    expect(p({ type: "response.output_audio_transcript.delta", item_id: "a1", delta: "he" })).toEqual({
      kind: "assistant_transcript_delta",
      itemId: "a1",
      delta: "he",
    });
    expect(p({ type: "response.audio_transcript.done", item_id: "a1", transcript: "hello" })).toEqual({
      kind: "assistant_transcript_done",
      itemId: "a1",
      text: "hello",
    });
    expect(p({ type: "conversation.item.truncated", item_id: "a1", transcript: "hel" })).toEqual({
      kind: "item_truncated",
      itemId: "a1",
      text: "hel",
    });
    expect(p({ type: "response.function_call_arguments.done", call_id: "c", name: "send_task", arguments: "{}" })).toEqual({
      kind: "function_call",
      callId: "c",
      name: "send_task",
      arguments: "{}",
    });
    expect(p({ type: "error", error: { type: "server_error", code: "internal_error", message: "boom" } })).toEqual({
      kind: "error",
      type: "server_error",
      code: "internal_error",
      message: "boom",
    });
  });

  it("drops binary frames, garbage and unknown events", () => {
    expect(parseServerEvent(new ArrayBuffer(4)).kind).toBe("unsupported");
    expect(parseServerEvent("{not json").kind).toBe("unsupported");
    expect(p({ type: "rate_limits.updated" })).toEqual({ kind: "unsupported", type: "rate_limits.updated" });
    expect(p({ type: "response.audio.delta" }).kind).toBe("unsupported");
  });
});

describe("helpers", () => {
  it("reads the line like Grok Bot's response gate", () => {
    const base = { socketIsWritable: true, callerIsSpeaking: false, responseIsInFlight: false, speakerIsBusy: false };
    expect(readTheLine({ ...base, socketIsWritable: false, callerIsSpeaking: true })).toBe("dead");
    expect(readTheLine({ ...base, callerIsSpeaking: true, responseIsInFlight: true })).toBe("callers");
    expect(readTheLine({ ...base, speakerIsBusy: true })).toBe("busy");
    expect(readTheLine({ ...base, responseIsInFlight: true })).toBe("busy");
    expect(readTheLine(base)).toBe("free");
  });

  it("validates send_task requests without truncating", () => {
    expect(validateTaskRequest({ request: "  find the invoice  " }, 2000)).toEqual({ ok: true, request: "find the invoice" });
    expect(validateTaskRequest({ request: "   " }, 2000).ok).toBe(false);
    expect(validateTaskRequest({}, 2000).ok).toBe(false);
    const long = validateTaskRequest({ request: "x".repeat(2001) }, 2000);
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.error).toMatch(/2001.*2000/);
  });

  it("snaps speeds and formats durations", () => {
    expect(snapSpeed(1.1)).toBe(1);
    expect(snapSpeed(1.9)).toBe(2);
    expect(snapSpeed(Number.NaN)).toBe(1);
    expect(formatCallDuration(0)).toBe("0:00");
    expect(formatCallDuration(76_400)).toBe("1:16");
    expect(formatCallDuration(3_725_000)).toBe("1:02:05");
  });

  it("renders chimes with the right length, gain bound and silent edges", () => {
    const samples = renderChime([{ hz: 659.25, ms: 90 }, { hz: 987.77, ms: 150 }], 24_000);
    expect(samples.length).toBe(2160 + 3600);
    expect(samples[0]).toBe(0);
    expect(Math.max(...Array.from(samples, Math.abs))).toBeLessThanOrEqual(0.16);
  });
});
