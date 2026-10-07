import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CallAudio } from "./audio";
import { MicrophoneError } from "./audio";
import { STAY_SILENT_ERROR, VoiceCallEngine, type CallHost, type CallSocket, type Timers } from "./engine";
import { floatToPcm16Base64 } from "./pcm";
import type { VoiceCallTicket } from "./protocol";

class FakeSocket implements CallSocket {
  readyState = 0;
  binaryType = "blob";
  sent: any[] = [];
  closedWith: { code?: number; reason?: string } | null = null;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {}
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code?: number, reason?: string) {
    this.closedWith = { code, reason };
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  server(event: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
  drop(code = 1006, reason = "") {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
  types() {
    return this.sent.map((f) => f.type);
  }
  take() {
    const frames = this.sent;
    this.sent = [];
    return frames;
  }
}

class FakeAudio implements CallAudio {
  onFrame: ((samples: Float32Array) => void) | null = null;
  time = 0;
  cursor = 0;
  playing = false;
  dropped = 0;
  chimes = 0;
  closed = false;
  ended: (() => void) | null = null;
  grant!: () => void;
  deny!: (error: unknown) => void;
  start(onFrame: (samples: Float32Array) => void) {
    this.onFrame = onFrame;
    return new Promise<void>((resolve, reject) => {
      this.grant = resolve;
      this.deny = reject;
    });
  }
  schedule(samples: Float32Array) {
    if (samples.length === 0) return null;
    const startsAt = Math.max(this.cursor, this.time);
    this.cursor = startsAt + samples.length / 24_000;
    this.playing = true;
    return { startsAt, endsAt: this.cursor };
  }
  currentTime() {
    return this.time;
  }
  isPlaying() {
    return this.playing;
  }
  dropScheduled() {
    this.dropped += 1;
    this.cursor = this.time;
    this.playing = false;
  }
  onSpeechEnded(listener: () => void) {
    this.ended = listener;
  }
  streams() {
    return { microphone: null, speaker: null };
  }
  playConnectChime() {
    this.chimes += 1;
  }
  close() {
    this.closed = true;
  }
  finishPlaying() {
    this.playing = false;
    this.ended?.();
  }
}

class FakeTimers implements Timers {
  now = 0;
  private seq = 0;
  private pending = new Map<number, { at: number; fn: () => void }>();
  setTimeout(fn: () => void, ms: number) {
    const id = ++this.seq;
    this.pending.set(id, { at: this.now + ms, fn });
    return id;
  }
  clearTimeout(handle: unknown) {
    this.pending.delete(handle as number);
  }
  advance(ms: number) {
    const until = this.now + ms;
    for (;;) {
      const next = [...this.pending.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.pending.delete(next[0]);
      this.now = next[1].at;
      next[1].fn();
    }
    this.now = until;
  }
}

function ticket(secret = "s1"): VoiceCallTicket {
  return {
    credential: { clientSecret: secret, expiresAt: 0, model: "grok-voice", websocketUrl: "wss://api.x.ai/v1/realtime" },
    plan: {
      instructions: "you are bos",
      greeting: { direction: "greet them" },
      tools: [],
      receiptTurn: "say it is on its way",
      maxRequestChars: 2000,
    },
    options: { voices: ["liora", "eve"], speeds: [0.5, 1, 1.5, 2], languages: ["auto", "en", "ms"] },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const delta = (samples: number) => floatToPcm16Base64(new Float32Array(samples).fill(0.1));

let sockets: FakeSocket[];
let audio: FakeAudio;
let timers: FakeTimers;
let host: { sendTask: ReturnType<typeof vi.fn>; recall: ReturnType<typeof vi.fn> } & CallHost;
let mint: ReturnType<typeof vi.fn>;
let finished: ReturnType<typeof vi.fn>;
let hangupChime: ReturnType<typeof vi.fn>;
let saved: unknown[];

function makeEngine() {
  return new VoiceCallEngine({
    botId: "bot-1",
    mint: mint as () => Promise<VoiceCallTicket>,
    openSocket: (url, protocols) => {
      const socket = new FakeSocket(url, protocols);
      sockets.push(socket);
      return socket;
    },
    createAudio: () => audio,
    host,
    loadSettings: () => ({ voice: "eve", speed: 1, language: "auto" }),
    saveSettings: (settings) => saved.push(settings),
    playHangupChime: hangupChime as () => void,
    timers,
    now: () => timers.now,
    onFinished: finished as () => void,
  });
}

/** Dial, grant the mic, open the socket and confirm the session. */
async function goLive(engine = makeEngine()) {
  engine.start();
  audio.grant();
  await flush();
  const socket = sockets.at(-1)!;
  socket.open();
  socket.server({ type: "conversation.created", conversation: { id: "conv_1" } });
  socket.server({ type: "session.updated" });
  return { engine, socket };
}

beforeEach(() => {
  sockets = [];
  audio = new FakeAudio();
  timers = new FakeTimers();
  host = { sendTask: vi.fn(), recall: vi.fn(() => [{ who: "them", text: "hi" }]) } as any;
  mint = vi.fn(async () => ticket());
  finished = vi.fn();
  hangupChime = vi.fn();
  saved = [];
});

describe("dialling", () => {
  it("sends session.update only once the socket is open and the mic is granted", async () => {
    const engine = makeEngine();
    engine.start();
    await flush();
    const socket = sockets[0];
    expect(socket.url).toBe("wss://api.x.ai/v1/realtime?model=grok-voice");
    expect(socket.protocols).toEqual(["xai-client-secret.s1"]);
    expect(socket.binaryType).toBe("arraybuffer");
    socket.open();
    expect(socket.sent).toEqual([]);
    audio.grant();
    await flush();
    expect(socket.types()).toEqual(["session.update"]);
    expect(socket.sent[0].session.voice).toBe("eve");
    expect(socket.sent[0].session.keep_context).toBeUndefined();
    expect(engine.getSnapshot().phase).toBe("connecting");
  });

  it("goes live on session.updated with the connect chime and the greeting", async () => {
    const { engine, socket } = await goLive();
    expect(engine.getSnapshot().phase).toBe("live");
    expect(engine.getSnapshot().startedAtMs).toBe(0);
    expect(audio.chimes).toBe(1);
    expect(socket.sent.at(-1)).toEqual({ type: "response.create", response: { instructions: "greet them" } });
  });

  it("skips the greeting when the caller speaks first", async () => {
    const engine = makeEngine();
    engine.start();
    audio.grant();
    await flush();
    const socket = sockets[0];
    socket.open();
    socket.server({ type: "input_audio_buffer.speech_started", item_id: "u1" });
    socket.server({ type: "session.updated" });
    expect(engine.getSnapshot().phase).toBe("live");
    expect(socket.types()).not.toContain("response.create");
  });

  it("maps a 409 mint to the no-key failure and never opens a socket", async () => {
    mint.mockRejectedValueOnce({ status: 409, message: "" });
    const engine = makeEngine();
    engine.start();
    await flush();
    expect(sockets).toHaveLength(0);
    expect(engine.getSnapshot().phase).toBe("failed");
    expect(engine.getSnapshot().failure?.title).toBe("Voice calls need an xAI key");
    expect(audio.closed).toBe(true);
    expect(hangupChime).not.toHaveBeenCalled();
    expect(finished).toHaveBeenCalledTimes(1);
  });

  it("maps a 502 mint to xAI refused", async () => {
    mint.mockRejectedValueOnce({ status: 502 });
    const engine = makeEngine();
    engine.start();
    await flush();
    expect(engine.getSnapshot().failure?.title).toBe("xAI refused the call");
  });

  it("fails on a denied mic", async () => {
    const engine = makeEngine();
    engine.start();
    audio.deny(new MicrophoneError("denied", "no"));
    await flush();
    expect(engine.getSnapshot().failure?.code).toBe("microphone_denied");
  });

  it("fails when the mic prompt goes unanswered for 30s", async () => {
    const engine = makeEngine();
    engine.start();
    await flush();
    timers.advance(30_000);
    expect(engine.getSnapshot().failure?.code).toBe("microphone_prompt_unanswered");
    expect(sockets[0].closedWith).toEqual({ code: 1000, reason: "hang_up" });
  });

  it("treats a close before live as fatal", async () => {
    const engine = makeEngine();
    engine.start();
    audio.grant();
    await flush();
    sockets[0].open();
    sockets[0].drop(1006, "");
    expect(engine.getSnapshot().phase).toBe("failed");
    expect(mint).toHaveBeenCalledTimes(1);
  });
});

describe("audio", () => {
  it("streams mic frames as PCM16 appends, but not while muted", async () => {
    const { engine, socket } = await goLive();
    socket.take();
    audio.onFrame!(new Float32Array(2048));
    expect(socket.sent).toEqual([{ type: "input_audio_buffer.append", audio: floatToPcm16Base64(new Float32Array(2048)) }]);
    engine.setMuted(true);
    audio.onFrame!(new Float32Array(2048));
    expect(socket.sent).toHaveLength(1);
    engine.setMuted(false);
    audio.onFrame!(new Float32Array(2048));
    expect(socket.sent).toHaveLength(2);
  });

  it("does not stream before the session is invited", async () => {
    const engine = makeEngine();
    engine.start();
    audio.grant();
    await flush();
    audio.onFrame!(new Float32Array(2048));
    expect(sockets[0].sent).toEqual([]);
  });
});

describe("barge-in", () => {
  it("drops scheduled audio, ignores late deltas, and truncates once the response is done", async () => {
    const { engine, socket } = await goLive();
    socket.server({ type: "response.created", response: {} });
    socket.server({ type: "response.output_audio.delta", item_id: "a1", content_index: 0, delta: delta(24_000) });
    socket.server({ type: "response.output_audio_transcript.delta", item_id: "a1", delta: "hello there" });
    expect(engine.getSnapshot().activity).toBe("streaming");
    socket.take();

    audio.time = 0.4;
    socket.server({ type: "input_audio_buffer.speech_started", item_id: "u1" });
    expect(audio.dropped).toBe(1);
    expect(engine.getSnapshot().activity).toBe("listening");
    // Still responding: the truncate waits for response.done.
    expect(socket.types()).not.toContain("conversation.item.truncate");

    socket.server({ type: "response.output_audio.delta", item_id: "a1", content_index: 0, delta: delta(2400) });
    expect(audio.playing).toBe(false);

    socket.server({ type: "response.done", response: { status: "cancelled" } });
    expect(socket.sent).toEqual([{ type: "conversation.item.truncate", item_id: "a1", content_index: 0, audio_end_ms: 400 }]);
    const turn = engine.getSnapshot().transcript.find((t) => t.id === "a1");
    expect(turn?.settled).toBe(true);
  });

  it("truncates at once when no response is open", async () => {
    const { socket } = await goLive();
    socket.server({ type: "response.created", response: {} });
    socket.server({ type: "response.output_audio.delta", item_id: "a1", content_index: 0, delta: delta(48_000) });
    socket.server({ type: "response.done", response: {} });
    socket.take();
    audio.time = 1.25;
    socket.server({ type: "input_audio_buffer.speech_started", item_id: "u1" });
    expect(socket.sent).toEqual([{ type: "conversation.item.truncate", item_id: "a1", content_index: 0, audio_end_ms: 1250 }]);
  });

  it("sends no truncate when everything was heard", async () => {
    const { socket } = await goLive();
    socket.server({ type: "response.created", response: {} });
    socket.server({ type: "response.output_audio.delta", item_id: "a1", content_index: 0, delta: delta(2400) });
    socket.server({ type: "response.done", response: {} });
    socket.take();
    audio.time = 5;
    socket.server({ type: "input_audio_buffer.speech_started", item_id: "u1" });
    expect(socket.types()).not.toContain("conversation.item.truncate");
  });
});

describe("tools", () => {
  async function liveAndIdle() {
    const live = await goLive();
    live.socket.server({ type: "response.created", response: {} });
    return live;
  }

  it("send_task returns the receipt, owes the receipt turn, and dispatches the job", async () => {
    const { engine, socket } = await liveAndIdle();
    socket.take();
    socket.server({
      type: "response.function_call_arguments.done",
      call_id: "c1",
      name: "send_task",
      arguments: JSON.stringify({ request: "  check the invoices  " }),
    });
    expect(socket.sent[0]).toMatchObject({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: "c1" },
    });
    expect(JSON.parse(socket.sent[0].item.output).status).toBe("sent");
    expect(host.sendTask).toHaveBeenCalledWith("check the invoices", expect.any(Function));
    expect(engine.getSnapshot().pendingTasks).toBe(1);
    // The response is still open, so the receipt turn waits for response.done.
    expect(socket.types()).not.toContain("response.create");
    socket.server({ type: "response.done", response: {} });
    expect(socket.sent.at(-1)).toEqual({ type: "response.create", response: { instructions: "say it is on its way" } });
  });

  it("send_task skips the receipt turn when the model already spoke", async () => {
    const { socket } = await liveAndIdle();
    socket.server({ type: "response.output_audio_transcript.delta", item_id: "a1", delta: "on it" });
    socket.take();
    socket.server({ type: "response.function_call_arguments.done", call_id: "c1", name: "send_task", arguments: '{"request":"x"}' });
    socket.server({ type: "response.done", response: {} });
    expect(socket.types()).not.toContain("response.create");
  });

  it("send_task rejects an oversized request without dispatching", async () => {
    const { socket } = await liveAndIdle();
    socket.take();
    socket.server({
      type: "response.function_call_arguments.done",
      call_id: "c1",
      name: "send_task",
      arguments: JSON.stringify({ request: "x".repeat(2001) }),
    });
    expect(JSON.parse(socket.sent[0].item.output).error).toMatch(/2000/);
    expect(host.sendTask).not.toHaveBeenCalled();
  });

  it("a failed dispatch asks for a spoken apology turn", async () => {
    host.sendTask.mockImplementation((_request: string, onFailed: () => void) => onFailed());
    const { engine, socket } = await liveAndIdle();
    socket.server({ type: "response.function_call_arguments.done", call_id: "c1", name: "send_task", arguments: '{"request":"x"}' });
    expect(engine.getSnapshot().pendingTasks).toBe(0);
    socket.take();
    socket.server({ type: "response.done", response: {} });
    expect(socket.sent.at(-1).response.instructions).toMatch(/did not reach the chat/);
  });

  it("recall_text_messages answers with the chat and asks for a turn", async () => {
    const { socket } = await liveAndIdle();
    socket.take();
    socket.server({ type: "response.function_call_arguments.done", call_id: "c2", name: "recall_text_messages", arguments: "{}" });
    expect(JSON.parse(socket.sent[0].item.output)).toEqual({ messages: [{ who: "them", text: "hi" }] });
    socket.server({ type: "response.done", response: {} });
    expect(socket.sent.at(-1)).toEqual({ type: "response.create" });
  });

  it("stay_silent is refused when the caller spoke last", async () => {
    const { socket } = await goLive();
    socket.server({ type: "response.created", response: {} });
    socket.server({ type: "input_audio_buffer.speech_started", item_id: "u1" });
    socket.server({ type: "input_audio_buffer.speech_stopped" });
    socket.server({ type: "response.done", response: {} });
    socket.server({ type: "response.created", response: {} });
    socket.take();
    socket.server({ type: "response.function_call_arguments.done", call_id: "c3", name: "stay_silent", arguments: "{}" });
    expect(JSON.parse(socket.sent[0].item.output)).toEqual({ error: STAY_SILENT_ERROR });
    socket.server({ type: "response.done", response: {} });
    expect(socket.sent.at(-1).response.instructions).toBe(STAY_SILENT_ERROR);
  });

  it("stay_silent is honoured when the model spoke last", async () => {
    const { socket } = await liveAndIdle();
    socket.take();
    socket.server({ type: "response.function_call_arguments.done", call_id: "c3", name: "stay_silent", arguments: "{}" });
    expect(JSON.parse(socket.sent[0].item.output)).toEqual({});
    socket.server({ type: "response.done", response: {} });
    expect(socket.types()).not.toContain("response.create");
  });

  it("end_the_call waits for response.done and the goodbye to finish playing", async () => {
    const { engine, socket } = await liveAndIdle();
    socket.server({ type: "response.output_audio.delta", item_id: "a1", content_index: 0, delta: delta(24_000) });
    socket.server({ type: "response.function_call_arguments.done", call_id: "c4", name: "end_the_call", arguments: "{}" });
    expect(engine.getSnapshot().phase).toBe("ending");
    socket.server({ type: "response.done", response: {} });
    expect(engine.getSnapshot().phase).toBe("ending");
    audio.finishPlaying();
    expect(engine.getSnapshot().phase).toBe("idle");
    expect(socket.closedWith).toEqual({ code: 1000, reason: "hang_up" });
    expect(hangupChime).toHaveBeenCalledTimes(1);
    expect(finished).toHaveBeenCalledTimes(1);
  });

  it("end_the_call hangs up after 15s even if the goodbye never ends", async () => {
    const { engine, socket } = await liveAndIdle();
    socket.server({ type: "response.function_call_arguments.done", call_id: "c4", name: "end_the_call", arguments: "{}" });
    timers.advance(14_999);
    expect(engine.getSnapshot().phase).toBe("ending");
    timers.advance(1);
    expect(engine.getSnapshot().phase).toBe("idle");
  });
});

describe("work landed", () => {
  it("sends async_update.add while live", async () => {
    timers.now = 5000;
    const { engine, socket } = await goLive();
    socket.take();
    engine.workLanded("  invoices sent  ");
    expect(socket.sent).toHaveLength(1);
    expect(socket.sent[0]).toMatchObject({
      type: "async_update.add",
      async_update: { topic: "work_landed", payload: [{ message: { type: "text", content: "invoices sent" }, timestampMs: 5000 }] },
    });
  });

  it("queues while reconnecting and flushes once live again", async () => {
    const { engine, socket } = await goLive();
    socket.drop(1006, "");
    expect(engine.getSnapshot().phase).toBe("reconnecting");
    engine.workLanded("done while away");
    timers.advance(0);
    await flush();
    const next = sockets[1];
    next.open();
    next.server({ type: "session.updated" });
    expect(next.types().at(-1)).toBe("async_update.add");
    expect(next.sent.at(-1).async_update.payload[0].message.content).toBe("done while away");
  });
});

describe("reconnect", () => {
  it("re-mints, rejoins the conversation with keep_context false and replays history", async () => {
    const { engine, socket } = await goLive();
    socket.server({ type: "conversation.item.input_audio_transcription.completed", item_id: "u1", transcript: "hello" });
    socket.server({ type: "response.created", response: {} });
    socket.server({ type: "response.output_audio_transcript.done", item_id: "a1", transcript: "hi firaz" });
    socket.server({ type: "response.done", response: {} });

    mint.mockImplementationOnce(async () => ticket("s2"));
    socket.drop(1006, "");
    expect(engine.getSnapshot().phase).toBe("reconnecting");
    expect(sockets).toHaveLength(1);
    timers.advance(0);
    await flush();
    expect(mint).toHaveBeenCalledTimes(2);
    const next = sockets[1];
    expect(next.url).toBe("wss://api.x.ai/v1/realtime?model=grok-voice&conversation_id=conv_1");
    expect(next.protocols).toEqual(["xai-client-secret.s2"]);
    next.open();
    expect(next.sent[0].type).toBe("session.update");
    expect(next.sent[0].session.keep_context).toBe(false);
    expect(next.sent.slice(1)).toEqual([
      { type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] } },
      { type: "conversation.item.create", item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi firaz" }] } },
    ]);
    next.server({ type: "session.updated" });
    expect(engine.getSnapshot().phase).toBe("live");
    // No second chime or greeting on a reconnect.
    expect(audio.chimes).toBe(1);
    expect(next.types()).not.toContain("response.create");
  });

  it("backs off 0, 1000, 1200 ms between failed dials", async () => {
    const { engine, socket } = await goLive();
    socket.drop(1006, "");
    timers.advance(0);
    await flush();
    expect(sockets).toHaveLength(2);
    sockets[1].drop(1006, "");
    timers.advance(999);
    await flush();
    expect(sockets).toHaveLength(2);
    timers.advance(1);
    await flush();
    expect(sockets).toHaveLength(3);
    sockets[2].drop(1006, "");
    timers.advance(1199);
    await flush();
    expect(sockets).toHaveLength(3);
    timers.advance(1);
    await flush();
    expect(sockets).toHaveLength(4);
    expect(engine.getSnapshot().phase).toBe("reconnecting");
  });

  it("supersedes a dial that hangs past 15s", async () => {
    const { socket } = await goLive();
    socket.drop(1006, "");
    timers.advance(0);
    await flush();
    timers.advance(15_000);
    expect(sockets[1].closedWith).toEqual({ code: 4001, reason: "superseded" });
  });

  it("gives up after 20 attempts", async () => {
    const { engine, socket } = await goLive();
    mint.mockImplementation(async () => {
      throw { status: 502 };
    });
    socket.drop(1006, "");
    for (let i = 0; i < 25; i++) {
      timers.advance(10_000);
      await flush();
    }
    expect(engine.getSnapshot().phase).toBe("failed");
    expect(engine.getSnapshot().failure?.code).toBe("realtime_connection_failed");
    expect(mint).toHaveBeenCalledTimes(21);
  });

  it("treats a 1008 policy close as fatal", async () => {
    const { engine, socket } = await goLive();
    socket.drop(1008, "policy");
    expect(engine.getSnapshot().phase).toBe("failed");
    expect(engine.getSnapshot().failure?.code).toBe("far_end");
  });
});

describe("settings and hang up", () => {
  it("re-sends session.update mid-call and saves the change", async () => {
    const { engine, socket } = await goLive();
    socket.take();
    engine.updateSettings({ voice: "liora", language: "ms" });
    expect(saved).toEqual([{ voice: "liora", speed: 1, language: "ms" }]);
    expect(socket.sent[0].session.voice).toBe("liora");
    expect(socket.sent[0].session.audio.input.transcription.language_hint).toBe("ms");
    engine.updateSettings({ voice: "liora" });
    expect(socket.sent).toHaveLength(1);
  });

  it("hang up closes 1000 hang_up, plays the hangup chime and notifies once", async () => {
    const { engine, socket } = await goLive();
    engine.hangUp();
    engine.hangUp();
    expect(socket.closedWith).toEqual({ code: 1000, reason: "hang_up" });
    expect(audio.closed).toBe(true);
    expect(hangupChime).toHaveBeenCalledTimes(1);
    expect(finished).toHaveBeenCalledTimes(1);
    expect(engine.getSnapshot().phase).toBe("idle");
  });
});
