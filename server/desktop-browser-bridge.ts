// Private Electron utility-process transport. No public endpoint or model credential.
type Request = { type: 'bos:shared-browser-request'; requestId: string; botId: string; threadId: string; method: string; params: unknown; deadline: number };
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
export class DesktopBrowserBridge {
  private pending = new Map<string, Pending>();
  private send: (request: Request) => boolean;
  constructor(send: (request: Request) => boolean) { this.send = send; }
  request(botId: string, threadId: string, method: string, params: unknown): Promise<unknown> {
    if (this.pending.size >= 16) return Promise.reject(new Error('The in-app browser is busy.'));
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error('In-app browser action timed out; outcome unknown. Take control and check the page before sharing again.')); }, 10000);
      timer.unref(); this.pending.set(requestId, { resolve, reject, timer });
      if (!this.send({ type: 'bos:shared-browser-request', requestId, botId, threadId, method, params, deadline: Date.now() + 10000 })) {
        clearTimeout(timer); this.pending.delete(requestId); reject(new Error('The desktop browser is not connected.'));
      }
    });
  }
  receive(message: unknown): boolean {
    if (!message || typeof message !== 'object' || !('type' in message) || message.type !== 'bos:shared-browser-result') return false;
    const m = message as { requestId?: string; ok?: boolean; result?: unknown; error?: string };
    const pending = m.requestId && this.pending.get(m.requestId); if (!pending) return true;
    clearTimeout(pending.timer); this.pending.delete(m.requestId!);
    if (m.ok === true) pending.resolve(m.result); else pending.reject(new Error(typeof m.error === 'string' ? m.error.slice(0,1000) : 'The shared browser request failed.'));
    return true;
  }
}
