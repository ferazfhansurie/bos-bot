import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AudioAttachment, loadAudioResource } from "./AudioAttachment";

const file = { name: "memo.wav", path: "/private/memo.wav", private: true };
const message = { threadId: "thread/one", messageId: "message two" };
afterEach(() => vi.unstubAllGlobals());
describe("voice memo playback boundary", () => {
  it("does not load or play files on initial render", () => {
    const markup = renderToStaticMarkup(createElement(AudioAttachment, { file, message }));
    expect(markup).toContain("load voice memo");
    expect(markup).not.toContain("<audio");
    expect(markup).not.toContain("src=");
  });
  it("reads only through exact-message authorization with accepted MIME", async () => {
    const fetcher = vi.fn(async () => new Response("audio bytes", { headers: { "content-type": "audio/wav" } }));
    vi.stubGlobal("fetch", fetcher);
    const signal = new AbortController().signal;
    expect((await loadAudioResource(file, message, signal)).type).toBe("audio/wav");
    expect(fetcher).toHaveBeenCalledWith("/api/threads/thread%2Fone/messages/message%20two/file", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: file.path }), signal });
  });
  it("preserves ownership failures and rejects wrong MIME and oversized bytes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "outside this conversation" }), { status: 403 })));
    await expect(loadAudioResource(file, message, new AbortController().signal)).rejects.toThrow("outside this conversation");
    for (const mime of ["text/html", "application/octet-stream", "video/mp4"]) {
      vi.stubGlobal("fetch", vi.fn(async () => new Response("bad", { headers: { "content-type": mime } })));
      await expect(loadAudioResource(file, message, new AbortController().signal)).rejects.toThrow("audio unavailable");
    }
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad", { headers: { "content-type": "audio/wav", "content-length": String(26 * 1024 * 1024) } })));
    await expect(loadAudioResource(file, message, new AbortController().signal)).rejects.toThrow("25 mb");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x".repeat(256_001), { headers: { "content-type": "text/vtt" } })));
    await expect(loadAudioResource(file, message, new AbortController().signal, true)).rejects.toThrow("size limit");
  });
});
