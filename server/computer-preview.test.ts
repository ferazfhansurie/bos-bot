import { describe, expect, it, vi } from "vitest";
import { ComputerPreview, createHostPreview, type PreviewSource } from "./computer-preview.ts";
const frame = { png: "aGVsbG8=", format: "png" };
const source: PreviewSource = { surface: "vm", key: "vm:a", fingerprint: "a" };
describe("computer preview isolation", () => {
  it("coalesces captures but rechecks authorization separately before release", async () => {
    let finish!: (value: typeof frame) => void;
    const capture = vi.fn(() => new Promise<typeof frame>(resolve => { finish = resolve; }));
    const service = new ComputerPreview();
    let allowed = true;
    const resolve = async () => { if (!allowed) throw new Error("revoked"); return source; };
    const a = service.capture(resolve, capture);
    const b = service.capture(resolve, capture);
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1));
    allowed = false; finish(frame);
    await expect(a).rejects.toThrow("revoked"); await expect(b).rejects.toThrow("revoked");
  });
  it("discards a frame when the selected surface changes", async () => {
    let current = source;
    await expect(new ComputerPreview().capture(async () => current, async () => {
      current = { ...source, surface: "local", key: "host" }; return frame;
    })).rejects.toThrow("selected computer changed");
  });
  it("never captures a denied source and rejects invalid frames", async () => {
    const capture = vi.fn(async () => frame);
    await expect(new ComputerPreview().capture(async () => { throw new Error("off"); }, capture)).rejects.toThrow("off");
    expect(capture).not.toHaveBeenCalled();
    await expect(new ComputerPreview().capture(async () => source, async () => ({ ...frame, png: "bad-url" }))).rejects.toThrow("invalid preview");
  });
  it("uses only its correlated private reply and refuses plain Node host fallback", async () => {
    await expect(createHostPreview(undefined)()).rejects.toThrow("desktop app");
    let receive!: (event: { data?: object }) => void;
    const post = vi.fn();
    const capture = createHostPreview({ on: (_, handler) => { receive = handler; }, postMessage: post });
    const work = capture();
    const request = post.mock.calls[0][0];
    receive({ data: { type: "bos:computer-preview-result", requestId: "wrong", ok: true, png: "wrong" } });
    receive({ data: { type: "bos:computer-preview-result", requestId: request.requestId, ok: true, png: frame.png } });
    await expect(work).resolves.toEqual(frame);
  });
});
