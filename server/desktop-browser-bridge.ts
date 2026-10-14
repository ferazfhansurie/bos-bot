// Private Electron utility-process transport. No public endpoint or model credential.
// The desktop app drives the person's own browser tabs (electron/shared-browser.mjs);
// this carries one tool call there and its result back.
type Request = { type: 'bos:shared-browser-request'; requestId: string; botId: string; threadId: string; method: string; params: unknown; deadline: number; generation?: string; profileId?: string };
type Release = { type: 'bos:shared-browser-release'; threadId: string; generation?: string };
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
export class DesktopBrowserBridge {
  private pending = new Map<string, Pending>();
  private send: (message: Request | Release) => boolean;
  constructor(send: (message: Request | Release) => boolean) { this.send = send; }
  /** timeoutMs is the desktop's own deadline; the bridge waits two seconds longer
   * so the desktop's clearer error wins over a bare transport timeout. */
  request(botId: string, threadId: string, method: string, params: unknown, timeoutMs = 20000, authority: { generation?: string; profileId?: string } = {}): Promise<unknown> {
    if (this.pending.size >= 16) return Promise.reject(new Error('The browser is busy. Try again in a moment.'));
    const requestId = crypto.randomUUID();
    const budget = Math.max(1000, Math.min(60000, timeoutMs));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error('The browser did not answer in time; the outcome is unknown. Take a snapshot to check the page before repeating anything.')); }, budget + 2000);
      timer.unref(); this.pending.set(requestId, { resolve, reject, timer });
      if (!this.send({ type: 'bos:shared-browser-request', requestId, botId, threadId, method, params, deadline: Date.now() + budget, ...authority })) {
        clearTimeout(timer); this.pending.delete(requestId); reject(new Error('The desktop browser is not connected.'));
      }
    });
  }
  /** A turn ended: the desktop hands every tab the conversation held back to the person. */
  release(threadId: string, generation?: string): void { try { this.send({ type: 'bos:shared-browser-release', threadId, generation }); } catch { /* desktop gone */ } }
  receive(message: unknown): boolean {
    if (!message || typeof message !== 'object' || !('type' in message) || message.type !== 'bos:shared-browser-result') return false;
    const m = message as { requestId?: string; ok?: boolean; result?: unknown; error?: string };
    const pending = m.requestId && this.pending.get(m.requestId); if (!pending) return true;
    clearTimeout(pending.timer); this.pending.delete(m.requestId!);
    if (m.ok === true) pending.resolve(m.result); else pending.reject(new Error(typeof m.error === 'string' ? m.error.slice(0,1000) : 'The browser request failed.'));
    return true;
  }
}
