// A browser voice message must reach the bot or stay on screen: upload, then
// transcript, then send; a failed transcript still sends the audio.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetVoiceSendForTests, deliverVoice, queueVoiceMessage, type VoiceDispatch } from "./voice-send";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const blob = () => new Blob([new Uint8Array(4000)], { type: "audio/webm" });
const flush = async () => { for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(2000); };

describe("voice message delivery", () => {
  let fetchMock: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.useFakeTimers();
    __resetVoiceSendForTests();
    fetchMock = vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    fetchMock.mockRestore();
    vi.useRealTimers();
  });

  const accept: VoiceDispatch = (action) => action.onSent();

  it("sends the transcript as the text with the recording attached", async () => {
    fetchMock.mockImplementation(async (url: string | URL | Request) => String(url).startsWith("/api/files")
      ? json(201, { path: "/data/attachments/a.webm", name: "Voice message.webm", bytes: 4000 })
      : json(200, { text: "tolong check UCO collection hari ni", language: "ms" }));
    const sent: Parameters<VoiceDispatch>[0][] = [];
    await queueVoiceMessage({ draftId: "d", target: { botId: "b1", threadId: "t1" }, blob: blob(), mime: "audio/webm", extension: "webm", durationMs: 4200 },
      (action) => { sent.push(action); action.onSent(); });
    await flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: "send", botId: "b1", threadId: "t1" });
    expect(sent[0]!.text).toBe('tolong check UCO collection hari ni\n\n<attached-file path="/data/attachments/a.webm" name="Voice message.webm" />');
  });

  it("still sends the audio with a marker when transcription keeps failing", async () => {
    fetchMock.mockImplementation(async (url: string | URL | Request) => String(url).startsWith("/api/files")
      ? json(201, { path: "/data/attachments/b.m4a", name: "v.m4a", bytes: 4000 })
      : json(502, { error: "relay down" }));
    const sent: string[] = [];
    await queueVoiceMessage({ draftId: "d", target: { groupId: "g1", threadId: "t2", mode: "chat" }, blob: blob(), mime: "audio/mp4", extension: "m4a", durationMs: 3000 },
      (action) => { sent.push(action.text); action.onSent(); });
    await flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/automatic transcription failed/);
    expect(sent[0]).toContain('<attached-file path="/data/attachments/b.m4a"');
    expect(fetchMock.mock.calls.filter(([url]: unknown[]) => String(url) === "/api/stt")).toHaveLength(3);
  });

  it("keeps the recording when the upload fails and resumes without uploading twice", async () => {
    let uploadOk = false;
    fetchMock.mockImplementation(async (url: string | URL | Request) => {
      if (String(url).startsWith("/api/files")) return uploadOk ? json(201, { path: "/data/attachments/c.webm", name: "c.webm", bytes: 4000 }) : json(503, { error: "down" });
      return json(200, { text: "hello" });
    });
    const sent: string[] = [];
    const dispatch: VoiceDispatch = (action) => { sent.push(action.text); action.onSent(); };
    const id = await queueVoiceMessage({ draftId: "d", target: { botId: "b", threadId: "t" }, blob: blob(), mime: "audio/webm", extension: "webm", durationMs: 2000 }, dispatch);
    await flush();
    expect(sent).toHaveLength(0);
    const uploadIds = fetchMock.mock.calls.map(([url]: unknown[]) => String(url)).filter((url: string) => url.startsWith("/api/files")).map((url: string) => new URL(url, "http://x").searchParams.get("uploadId"));
    expect(new Set(uploadIds).size).toBe(1);
    uploadOk = true;
    void deliverVoice(id, dispatch);
    await flush();
    expect(sent).toEqual(['hello\n\n<attached-file path="/data/attachments/c.webm" name="c.webm" />']);
  });

  it("holds a recording unsent when asked to", async () => {
    const dispatch = vi.fn(accept);
    await queueVoiceMessage({ draftId: "d", target: { botId: "b", threadId: "t" }, blob: blob(), mime: "audio/webm", extension: "webm", durationMs: 2000, hold: "left" }, dispatch);
    await flush();
    expect(dispatch).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
