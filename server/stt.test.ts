// Speech to text through the operator's relay: which paths may be sent, the
// retry policy, the memo the composer and the turn share, and the transcript
// block the model receives for a voice note.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "./config.ts";
import {
  __resetSttForTests,
  attachmentAudioPath,
  markComposerTranscribed,
  pendingVoiceAttachments,
  sttConfigured,
  transcribeAttachment,
  withVoiceTranscripts,
} from "./stt.ts";

const cfg: AppConfig = { stt: { relayUrl: "https://stt.example/", token: "tok" } } as AppConfig;
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let dir: string;
beforeEach(() => {
  __resetSttForTests();
  dir = mkdtempSync(join(tmpdir(), "stt-test-"));
});

const audio = (name: string, bytes = "RIFFfakeaudio") => {
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
};

describe("attachmentAudioPath", () => {
  it("accepts only audio directly inside the attachments folder", () => {
    expect(attachmentAudioPath(join(dir, "a.webm"), dir)).toBe(join(dir, "a.webm"));
    expect(attachmentAudioPath(join(dir, "a.m4a"), dir)).toBe(join(dir, "a.m4a"));
    expect(attachmentAudioPath(join(dir, "a.pdf"), dir)).toBeNull();
    expect(attachmentAudioPath(join(dir, "..", "a.webm"), dir)).toBeNull();
    expect(attachmentAudioPath(join(dir, "sub", "a.webm"), dir)).toBeNull();
    expect(attachmentAudioPath("/etc/passwd.ogg", dir)).toBeNull();
  });

  it("needs both a relay address and a token", () => {
    expect(sttConfigured(cfg)).toBe(true);
    expect(sttConfigured({ stt: { relayUrl: "https://x" } } as AppConfig)).toBe(false);
    expect(sttConfigured({} as AppConfig)).toBe(false);
  });
});

describe("transcribeAttachment", () => {
  it("retries a relay failure, sends the bearer token and audio mime, then memoizes", async () => {
    const path = audio("v.m4a");
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(reply(502, { error: "upstream" }))
      .mockResolvedValueOnce(reply(200, { text: " hello Sam ", language: "en", provider: "gpt-4o-transcribe" }));
    const result = await transcribeAttachment(cfg, path, { fetchImpl, dir });
    expect(result).toEqual({ text: "hello Sam", language: "en", provider: "gpt-4o-transcribe" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://stt.example/transcribe?name=v.m4a");
    expect(init.headers).toMatchObject({ authorization: "Bearer tok", "content-type": "audio/mp4" });
    await transcribeAttachment(cfg, path, { fetchImpl, dir });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not retry an audio the relay refuses", async () => {
    const path = audio("v.webm");
    const fetchImpl = vi.fn().mockResolvedValue(reply(413, { error: "too long" }));
    await expect(transcribeAttachment(cfg, path, { fetchImpl, dir })).rejects.toMatchObject({ status: 413 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refuses a path outside the attachments folder before any network call", async () => {
    const fetchImpl = vi.fn();
    await expect(transcribeAttachment(cfg, "/etc/hosts", { fetchImpl, dir })).rejects.toMatchObject({ status: 400 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("voice notes in a turn", () => {
  it("adds a transcript block for an attached voice note", async () => {
    const path = audio("note.ogg");
    const fetchImpl = vi.fn().mockResolvedValue(reply(200, { text: "tolong check UCO <today>", language: "ms" }));
    const text = `listen to this\n\n<attached-file path="${path}" name="WhatsApp Audio.ogg" />`;
    const out = await withVoiceTranscripts(cfg, text, { fetchImpl, dir });
    expect(out).toBe(`${text}\n\n<voice-transcript name="WhatsApp Audio.ogg" language="ms">\ntolong check UCO &lt;today&gt;\n</voice-transcript>`);
  });

  it("skips a recording the composer already sent as text", async () => {
    const path = audio("rec.webm");
    markComposerTranscribed(path);
    const text = `hello there\n\n<attached-file path="${path}" name="Voice message.webm" />`;
    expect(pendingVoiceAttachments(text, dir)).toEqual([]);
    const fetchImpl = vi.fn();
    expect(await withVoiceTranscripts(cfg, text, { fetchImpl, dir })).toBe(text);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("tells the model plainly when a voice note could not be transcribed", async () => {
    const path = audio("bad.mp3");
    const fetchImpl = vi.fn().mockResolvedValue(reply(422, { error: "no audio stream" }));
    const out = await withVoiceTranscripts(cfg, `<attached-file path="${path}" name="bad.mp3" />`, { fetchImpl, dir });
    expect(out).toContain('status="unavailable"');
    expect(out).toContain("no audio stream");
  });

  it("leaves text alone when the relay is not configured or nothing is audio", async () => {
    const path = audio("doc.pdf");
    const fetchImpl = vi.fn();
    const text = `<attached-file path="${path}" name="doc.pdf" />`;
    expect(await withVoiceTranscripts(cfg, text, { fetchImpl, dir })).toBe(text);
    expect(await withVoiceTranscripts({} as AppConfig, `<attached-file path="${audio("x.ogg")}" name="x" />`, { fetchImpl, dir })).toContain("<attached-file");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
