export function canConfirmJob(messages: readonly { role?: string; kind?: string; text?: string; turnOutcome?: { ok?: boolean } }[]): boolean {
  let asked = false, result = false;
  for (const message of messages) {
    if (message.role === "user" && message.kind === "text" && message.text?.trim()) { asked = true; result = false; }
    if (asked && message.role === "bot" && message.kind === "text" && message.text?.trim()) result = true;
    if (asked && result && message.turnOutcome?.ok === true) return true;
  }
  return false;
}
export class ProductActions {
  private readonly options: { installId: () => string | null; feedbackEnabled: () => boolean; fetch?: typeof fetch };
  constructor(options: { installId: () => string | null; feedbackEnabled: () => boolean; fetch?: typeof fetch }) { this.options = options; }
  async claim(input: unknown): Promise<{ ok: boolean }> {
    if (typeof input !== "string") return { ok: false };
    const email = input.trim().toLowerCase();
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false };
    return this.post("claim", { email });
  }
  async feedback(input: unknown): Promise<{ ok: boolean }> {
    if (!this.options.feedbackEnabled() || !input || typeof input !== "object") return { ok: false };
    const value = input as Record<string, unknown>;
    if (typeof value.text !== "string" || value.text.length > 4000 || value.rating !== undefined && value.rating !== "up" && value.rating !== "down") return { ok: false };
    const text = value.text.trim();
    if (!text && !value.rating) return { ok: false };
    return this.post("feedback", { text, ...(value.rating ? { rating: value.rating } : {}) });
  }
  private async post(path: "claim" | "feedback", payload: Record<string, unknown>): Promise<{ ok: boolean }> {
    const id = this.options.installId(); if (!id) return { ok: false };
    try {
      const response = await (this.options.fetch ?? fetch)(`https://bosbot.my/api/${path}`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ install_id: id, ...payload }), credentials: "omit", redirect: "error", signal: AbortSignal.timeout(5000) });
      await response.body?.cancel(); return { ok: response.ok };
    } catch { return { ok: false }; }
  }
}
