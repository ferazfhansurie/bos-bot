import { homeKey, type BridgeLink } from "./remote-bot-bridge.ts";
import { z } from "zod";
const botSchema = z.object({ id: z.string().regex(/^[\w-]{1,128}$/), name: z.string().max(100), title: z.string().max(200),
  busy: z.boolean(), activity: z.string().optional(), model: z.string().optional() });
export class DelegatedClient {
  private readonly homeId: string;
  private readonly links: () => BridgeLink[];
  private readonly fetcher: typeof fetch;
  constructor(homeId: string, links: () => BridgeLink[], fetcher: typeof fetch = fetch) { this.homeId = homeId; this.links = links; this.fetcher = fetcher; }
  resolve(id: string) {
    const match = /^rb-([a-f0-9]{12})-([\w-]{1,128})$/.exec(id);
    if (!match) return null;
    const link = this.links().find(link => homeKey(link.homeId) === match[1]);
    return link ? { homeId: link.homeId, botId: match[2] } : null;
  }
  async call(home: string, chief: string, method: string, path: string, body?: unknown) {
    const link = this.links().find(link => link.homeId === home);
    if (!link) throw new Error("Remote home is not linked");
    if (!/^\/api\/delegated\/(?:roster|coordinate(?:\/[\w-]+)?|bots(?:\/[\w-]+)?|catalog|setup|proposals\/[\w-]+)$/.test(path)) throw new Error("Invalid delegated route");
    const descriptor = await this.fetcher(new URL("/.well-known/openmausbot/environment", link.origin), { redirect: "error", signal: AbortSignal.timeout(20000) });
    if (!descriptor.ok) throw Object.assign(new Error("Remote home identity is unavailable"), { status: descriptor.status, retryable: descriptor.status >= 500 });
    const identity = await descriptor.json() as { environmentId?: string; delegatedProtocol?: number };
    if (identity.environmentId !== home) throw new Error("Remote home identity changed; delegated access refused");
    if (identity.delegatedProtocol !== 1) throw new Error(`update ${link.name || "partner"}'s BOS to use delegated coordination`);
    const response = await this.fetcher(new URL(path, link.origin), { method, redirect: "error", signal: AbortSignal.timeout(20000),
      headers: { authorization: `Bearer ${link.token}`, "x-bos-grantee-home": this.homeId, "x-bos-grantee-bot": chief,
        ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (response.status === 404) throw Object.assign(new Error("Remote delegated receipt or target is unavailable; do not repeat uncertain work"), { status: 404 });
    let result: any;
    try { result = await response.json(); } catch { throw new Error("Remote delegated response is invalid"); }
    if (!response.ok) throw Object.assign(new Error(response.status === 403 ? "No live delegation for this chief on the remote home" : "Remote delegated request failed"), { status: response.status, retryable: response.status >= 500 });
    return result;
  }
  async roster(chief: string) {
    const bots: Array<z.infer<typeof botSchema> & { home: string; section: string }> = [];
    const errors: string[] = [];
    for (const link of this.links()) {
      try {
        const result = await this.call(link.homeId, chief, "GET", "/api/delegated/roster");
        const parsed = z.object({ bots: z.array(botSchema).max(1000) }).parse(result);
        for (const bot of parsed.bots) bots.push({ ...bot, id: `rb-${homeKey(link.homeId)}-${bot.id}`, home: link.homeId, section: link.name });
      } catch (error) {
        if ((error as { status?: number }).status !== 403) errors.push(error instanceof Error ? error.message : "Remote roster unavailable");
      }
    }
    return { bots, errors };
  }
  private async readReceipt(chief: string, home: string, path: string, receipt: string, signal: AbortSignal) {
    let attempts = 0;
    try {
      for (;;) {
        signal.throwIfAborted();
        try { return await this.call(home, chief, "GET", path); }
        catch (error) {
          const transient = error instanceof TypeError || (error as { retryable?: boolean }).retryable ||
            (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name));
          if (!transient) throw error;
          // GET only; bounded by the handoff lifetime/cancellation. Never
          // repeat a mutation to recover a missing or uncertain response.
          await this.delay(signal, Math.min(2000 * 2 ** Math.min(attempts++, 4), 30000));
        }
      }
    } catch (error) {
      throw new Error(`Remote receipt ${receipt}: outcome remains pending or unknown; do not repeat the work. ${error instanceof Error ? error.message : "Receipt wait stopped"}`);
    }
  }
  async proposal(chief: string, home: string, requestId: string, signal: AbortSignal) {
    for (;;) {
      const result = await this.readReceipt(chief, home, `/api/delegated/proposals/${requestId}`, requestId, signal);
      if (result.state !== "pending") return { ok: result.state === "applied", text: JSON.stringify(result).slice(0, 24000) };
      await this.delay(signal);
    }
  }
  private delay(signal: AbortSignal, ms = 2000) {
    return new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(new Error("Remote receipt wait stopped; remote work was not replayed")); };
      const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
      signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
    });
  }
  async coordinate(chief: string, target: string, requestKey: string, message: string, signal: AbortSignal) {
    const route = this.resolve(target);
    if (!route) throw new Error("Remote target is no longer linked");
    let accepted;
    try { accepted = await this.call(route.homeId, chief, "POST", "/api/delegated/coordinate", { botId: route.botId, requestKey, message }); }
    catch { throw new Error(`Remote requestKey ${requestKey}: acceptance or outcome is unknown; do not repeat the work. The mutation was not replayed.`); }
    if (typeof accepted.requestId !== "string" || !/^[\w-]{1,128}$/.test(accepted.requestId)) throw new Error("Invalid delegated receipt");
    // Only safe GET receipt reads are retried; POST is never replayed after
    // a timeout. RoomHandoffs owns the lifetime and cancellation budget.
    for (;;) {
      signal.throwIfAborted();
      const result = await this.readReceipt(chief, route.homeId, `/api/delegated/coordinate/${accepted.requestId}`, accepted.requestId, signal);
      if (result.status === "completed" || result.status === "failed") return { ok: result.status === "completed", text: String(result.result ?? "").slice(0, 24000) };
      await this.delay(signal);
    }
  }
}
