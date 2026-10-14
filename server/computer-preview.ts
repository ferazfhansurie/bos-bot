import { randomUUID } from "node:crypto";

export type PreviewFrame = { png: string; format: string };
export type PreviewSource = { surface: "local" | "vm" | "cloud"; key: string; fingerprint: string };
export const previewError = (message: string, status = 409) => Object.assign(new Error(message), { status });

/** Coalesce only the capture, never the authorization checks for each caller. */
export class ComputerPreview {
  private pending = new Map<string, Promise<PreviewFrame>>();
  async capture(resolve: () => Promise<PreviewSource>, capture: (source: PreviewSource) => Promise<PreviewFrame>) {
    const source = await resolve();
    let work = this.pending.get(source.key);
    if (!work) {
      work = Promise.resolve().then(() => capture(source)).finally(() => this.pending.delete(source.key));
      this.pending.set(source.key, work);
    }
    const image = await work;
    const current = await resolve();
    if (current.key !== source.key || current.surface !== source.surface || current.fingerprint !== source.fingerprint) throw previewError("The selected computer changed; refresh its preview");
    if (!image.png || image.png.length > 24 * 1024 * 1024 || !/^[A-Za-z0-9+/=]+$/.test(image.png) || !["png", "jpeg"].includes(image.format)) throw previewError("The computer returned an invalid preview", 502);
    return { surface: source.surface, ...image };
  }
}

export function createHostPreview(port: { on(event: "message", listener: (event: { data?: object }) => void): void; postMessage(message: object): void } | undefined, timeoutMs = 8_000) {
  const pending = new Map<string, { resolve: (frame: PreviewFrame) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  port?.on("message", ({ data }) => {
    const message = data as { type?: string; requestId?: string; ok?: boolean; png?: string; error?: string } | undefined;
    if (message?.type !== "bos:computer-preview-result" || typeof message.requestId !== "string") return;
    const waiting = pending.get(message.requestId);
    if (!waiting) return;
    pending.delete(message.requestId); clearTimeout(waiting.timer);
    if (message.ok === true && typeof message.png === "string") waiting.resolve({ png: message.png, format: "png" });
    else waiting.reject(previewError(message.error || "This computer's screen preview is unavailable"));
  });
  return () => new Promise<PreviewFrame>((resolve, reject) => {
    if (!port) { reject(previewError("This computer's preview needs the running BOS desktop app")); return; }
    const requestId = randomUUID();
    const timer = setTimeout(() => { pending.delete(requestId); reject(previewError("This computer's screen preview timed out", 504)); }, timeoutMs);
    timer.unref?.();
    pending.set(requestId, { resolve, reject, timer });
    try { port.postMessage({ type: "bos:computer-preview", requestId, deadline: Date.now() + timeoutMs }); }
    catch { pending.delete(requestId); clearTimeout(timer); reject(previewError("This computer's screen preview is unavailable")); }
  });
}
