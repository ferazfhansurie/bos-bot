// Native WhatsApp contract, against a mocked whatsapp-web.js client: state is
// driven only by client events and the liveness probe, capture is exactly-once,
// saved sessions resume without a QR, failures back off and trip a breaker,
// and nothing that writes to the account is reachable.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveWhatsAppBrowser } from "./whatsapp-browser.ts";
import { WhatsAppNative, type WhatsAppNativeOptions } from "./whatsapp-native.ts";
import { WhatsAppService } from "./whatsapp-service.ts";
import { WhatsAppStore } from "./whatsapp-store.ts";
import type {
  CapturedMessage,
  CreateReadOnlyClient,
  ReadOnlyClientHandlers,
  ReadOnlyClientOptions,
} from "./whatsapp-types.ts";

// ── fakes ───────────────────────────────────────────────────────────────

class FakeTimers {
  now = 1_000_000;
  private seq = 0;
  private jobs = new Map<number, { at: number; fn: () => void; every?: number }>();
  setTimeout = (fn: () => void, ms: number) => this.add(fn, ms);
  setInterval = (fn: () => void, ms: number) => this.add(fn, ms, ms);
  clearTimeout = (handle: unknown) => void this.jobs.delete(handle as number);
  clearInterval = (handle: unknown) => void this.jobs.delete(handle as number);
  pending(): number[] {
    return [...this.jobs.values()].map((job) => job.at - this.now).sort((a, b) => a - b);
  }
  private add(fn: () => void, ms: number, every?: number): number {
    const id = ++this.seq;
    this.jobs.set(id, { at: this.now + ms, fn, every });
    return id;
  }
  async advance(ms: number): Promise<void> {
    const end = this.now + ms;
    for (;;) {
      const next = [...this.jobs.entries()].filter(([, job]) => job.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, job] = next;
      this.now = job.at;
      if (job.every) job.at += job.every;
      else this.jobs.delete(id);
      job.fn();
      await flush();
    }
    this.now = end;
    await flush();
  }
}

const flush = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

/** A fake whatsapp-web.js client. The send-family methods exist on it, like on
 * the real Client, and throw: the read-only wrapper must never reach them. */
class FakeRawClient {
  handlers!: ReadOnlyClientHandlers;
  options!: ReadOnlyClientOptions;
  initialize = vi.fn(async () => {});
  getState = vi.fn<() => Promise<string | null>>(async () => "CONNECTED");
  destroy = vi.fn(async () => {});
  sendMessage = vi.fn(() => { throw new Error("sendMessage reached"); });
  sendSeen = vi.fn(() => { throw new Error("sendSeen reached"); });
  reply = vi.fn(() => { throw new Error("reply reached"); });
  markChatUnread = vi.fn(() => { throw new Error("markChatUnread reached"); });
  sendPresenceAvailable = vi.fn(() => { throw new Error("sendPresenceAvailable reached"); });
  /** the one allowed call: presence → unavailable, via goInvisible() */
  sendPresenceUnavailable = vi.fn(async () => {});
}

function harness(overrides: Partial<WhatsAppNativeOptions> & { session?: boolean } = {}) {
  const timers = new FakeTimers();
  const clients: FakeRawClient[] = [];
  const inserted: CapturedMessage[] = [];
  const seen = new Set<string>();
  let session = overrides.session ?? false;
  const factory: CreateReadOnlyClient = (options, handlers) => {
    const raw = new FakeRawClient();
    raw.options = options;
    raw.handlers = handlers;
    clients.push(raw);
    // what the real wrapper returns: three methods, nothing else
    return { initialize: () => raw.initialize(), getState: () => raw.getState(), destroy: () => raw.destroy(), goInvisible: () => raw.sendPresenceUnavailable() };
  };
  const native = new WhatsAppNative({
    authDir: "/tmp/never-used-auth",
    clientId: "bos",
    cacheDir: "/tmp/never-used-cache",
    loadFactory: async () => factory,
    resolveBrowser: () => ({ path: "/fake/chrome", source: "env" }),
    store: {
      insert: (message) => {
        if (seen.has(message.id)) return false;
        seen.add(message.id);
        inserted.push(message);
        return true;
      },
      count: () => inserted.length,
    },
    sessionExists: () => session,
    releaseStaleProfile: () => {},
    clearSession: () => {
      session = false;
    },
    timers,
    now: () => timers.now,
    log: () => {},
    ...overrides,
  });
  return {
    native,
    timers,
    clients,
    inserted,
    latest: () => clients.at(-1)!,
    setSession: (value: boolean) => {
      session = value;
    },
  };
}

const message = (over: Partial<CapturedMessage> = {}): CapturedMessage => ({
  id: "false_123@c.us_AAA",
  chatId: "123@c.us",
  chatName: "Ana",
  from: "123@c.us",
  author: null,
  fromMe: false,
  timestamp: 1_700_000_000,
  type: "chat",
  body: "hello",
  hasMedia: false,
  ...over,
});

// ── state machine ───────────────────────────────────────────────────────

describe("WhatsAppNative link state", () => {
  it("walks not_linked → linking → qr_pending → linking → linked from client events only", async () => {
    const { native, latest } = harness();
    expect(native.snapshot().state).toBe("not_linked");
    const connecting = await native.connect();
    expect(connecting.state).toBe("linking");
    expect(latest().initialize).toHaveBeenCalledTimes(1);

    latest().handlers.onQr("QR-PAYLOAD-1");
    expect(native.snapshot()).toMatchObject({ state: "qr_pending", qr: "QR-PAYLOAD-1" });
    latest().handlers.onQr("QR-PAYLOAD-2");
    expect(native.snapshot().qr).toBe("QR-PAYLOAD-2");

    latest().handlers.onAuthenticated();
    expect(native.snapshot()).toMatchObject({ state: "linking", qr: null });

    latest().handlers.onReady();
    expect(native.snapshot()).toMatchObject({ state: "linked", qr: null, failures: 0 });
  });

  it("passes the read-only launch options through to the client", async () => {
    const { native, latest } = harness();
    await native.connect();
    expect(latest().options).toMatchObject({ clientId: "bos", executablePath: "/fake/chrome", deviceName: "BOS Bot" });
  });

  it("is never statically ready: a dead page found by the probe reads as disconnected", async () => {
    const { native, latest, timers, setSession } = harness();
    await native.connect();
    latest().handlers.onReady();
    setSession(true);
    latest().getState.mockRejectedValueOnce(new Error("Session closed"));
    await timers.advance(30_000);
    expect(native.snapshot().state).toBe("disconnected");
    expect(native.snapshot().reason).toMatch(/browser is gone/);
  });

  it("a hung probe times out into disconnected", async () => {
    const { native, latest, timers } = harness();
    await native.connect();
    latest().handlers.onReady();
    latest().getState.mockImplementation(() => new Promise(() => {}));
    await timers.advance(30_000 + 15_000);
    expect(native.snapshot().state).toBe("disconnected");
  });

  it("change_state and probe answers map onto the tile states", async () => {
    const { native, latest } = harness();
    await native.connect();
    latest().handlers.onReady();
    latest().handlers.onStateChange("OPENING");
    expect(native.snapshot().state).toBe("linking");
    latest().handlers.onStateChange("CONNECTED");
    expect(native.snapshot().state).toBe("linked");
    latest().handlers.onStateChange("CONFLICT");
    expect(native.snapshot().state).toBe("disconnected");
    latest().getState.mockResolvedValueOnce("CONNECTED");
    await native.probe();
    expect(native.snapshot().state).toBe("linked");
  });

  it("auth_failure and LOGOUT ask for a rescan; Rescan clears the rejected session and shows a fresh QR", async () => {
    const h = harness({ session: true });
    await h.native.autoStart();
    h.latest().handlers.onAuthFailure("bad session");
    expect(h.native.snapshot().state).toBe("needs_rescan");
    await flush();
    expect(h.clients[0].destroy).toHaveBeenCalled();

    await h.native.reconnect();
    expect(h.native.snapshot().sessionExists).toBe(false);
    h.latest().handlers.onQr("NEW-QR");
    expect(h.native.snapshot()).toMatchObject({ state: "qr_pending", qr: "NEW-QR" });

    h.latest().handlers.onReady();
    h.latest().handlers.onDisconnected("LOGOUT");
    expect(h.native.snapshot().state).toBe("needs_rescan");
  });

  it("an expired QR returns to not_linked and does not retry on its own", async () => {
    const { native, latest, timers, clients } = harness();
    await native.connect();
    latest().handlers.onQr("QR");
    latest().handlers.onDisconnected("Max qrcode retries reached");
    expect(native.snapshot()).toMatchObject({ state: "not_linked", qr: null });
    await timers.advance(60 * 60_000);
    expect(clients).toHaveLength(1);
  });

  it("ignores events from a client that has been replaced", async () => {
    const { native, clients } = harness();
    await native.connect();
    await native.reconnect();
    expect(clients).toHaveLength(2);
    clients[0].handlers.onReady();
    expect(native.snapshot().state).toBe("linking");
    clients[1].handlers.onReady();
    expect(native.snapshot().state).toBe("linked");
  });

  it("keeps exactly one client: repeated Connect is idempotent and replacing destroys the old one first", async () => {
    const { native, clients } = harness();
    await Promise.all([native.connect(), native.connect(), native.connect()]);
    await native.connect();
    expect(clients).toHaveLength(1);
    await native.reconnect();
    expect(clients).toHaveLength(2);
    expect(clients[0].destroy).toHaveBeenCalledTimes(1);
    expect(clients[0].destroy.mock.invocationCallOrder[0]).toBeLessThan(clients[1].initialize.mock.invocationCallOrder[0]);
  });

  it("reports a missing browser instead of starting", async () => {
    const { native, clients } = harness({ resolveBrowser: () => null, noBrowserReason: () => "No Chrome or Chromium was found." });
    const snapshot = await native.connect();
    expect(snapshot).toMatchObject({ state: "disconnected", circuitOpen: true, reason: "No Chrome or Chromium was found." });
    expect(clients).toHaveLength(0);
  });

  it("shutdown destroys the client and stops every timer", async () => {
    const { native, latest, timers } = harness();
    await native.connect();
    latest().handlers.onReady();
    await native.shutdown();
    expect(latest().destroy).toHaveBeenCalledTimes(1);
    expect(timers.pending()).toEqual([]);
  });
});

// ── presence ────────────────────────────────────────────────────────────

describe("WhatsAppNative presence", () => {
  it("goes invisible once after ready", async () => {
    const { native, latest } = harness();
    await native.connect();
    latest().handlers.onQr("QR");
    latest().handlers.onAuthenticated();
    expect(latest().sendPresenceUnavailable).not.toHaveBeenCalled();
    latest().handlers.onReady();
    await flush();
    expect(latest().sendPresenceUnavailable).toHaveBeenCalledTimes(1);
    // a CONNECTED that only confirms the current state does not repeat it
    latest().handlers.onStateChange("CONNECTED");
    await flush();
    expect(latest().sendPresenceUnavailable).toHaveBeenCalledTimes(1);
  });

  it("goes invisible again on every reconnect", async () => {
    const { native, latest, timers, clients } = harness({ session: true });
    await native.autoStart();
    latest().handlers.onReady();
    // dropped and auto-retried: a new client, invisible again once ready
    latest().handlers.onDisconnected("NAVIGATION");
    await timers.advance(5_000);
    latest().handlers.onReady();
    // the Reconnect button
    await native.reconnect();
    latest().handlers.onReady();
    // a drop and recovery within the same client
    latest().handlers.onStateChange("OPENING");
    latest().handlers.onStateChange("CONNECTED");
    await flush();
    expect(clients.map((raw) => raw.sendPresenceUnavailable.mock.calls.length)).toEqual([1, 1, 2]);
  });

  it("a failing presence call is logged and changes nothing", async () => {
    const lines: string[] = [];
    const { native, latest } = harness({ log: (line) => lines.push(line) });
    await native.connect();
    latest().sendPresenceUnavailable.mockRejectedValueOnce(new Error("page closed"));
    expect(() => latest().handlers.onReady()).not.toThrow();
    await flush();
    expect(native.snapshot()).toMatchObject({ state: "linked", failures: 0 });
    expect(lines.some((line) => /presence.*page closed/.test(line))).toBe(true);
  });
});

// ── capture ─────────────────────────────────────────────────────────────

describe("WhatsAppNative capture", () => {
  it("stores a message that message_create delivers twice exactly once", async () => {
    const { native, latest, inserted } = harness();
    await native.connect();
    latest().handlers.onReady();
    latest().handlers.onMessage(message());
    latest().handlers.onMessage(message());
    expect(inserted).toHaveLength(1);
    expect(native.snapshot().messageCount).toBe(1);
  });

  it("stores both received and sent-by-me messages", async () => {
    const { native, latest, inserted } = harness();
    await native.connect();
    latest().handlers.onReady();
    latest().handlers.onMessage(message({ id: "false_123@c.us_IN", fromMe: false }));
    latest().handlers.onMessage(message({ id: "true_123@c.us_OUT", fromMe: true, from: "me@c.us", body: "hi back" }));
    expect(inserted.map((row) => row.fromMe)).toEqual([false, true]);
  });
});

describe("WhatsAppStore", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omb-wa-store-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("INSERT OR IGNOREs by serialized id and keeps fromMe and received rows", () => {
    const store = new WhatsAppStore(join(dir, "messages.db"));
    expect(store.insert(message({ id: "a", body: "in" }))).toBe(true);
    expect(store.insert(message({ id: "a", body: "in again" }))).toBe(false);
    expect(store.insert(message({ id: "b", fromMe: true, body: "out", timestamp: 1_700_000_010 }))).toBe(true);
    expect(store.count()).toBe(2);
    const rows = store.listMessages({ chatId: "123@c.us" });
    expect(rows.map((row) => [row.id, row.fromMe, row.body])).toEqual([["b", true, "out"], ["a", false, "in"]]);
    expect(store.listMessages({ query: "OU" }).map((row) => row.id)).toEqual(["b"]);
    expect(store.listMessages({ query: "%" })).toEqual([]);
    expect(store.listChats()).toMatchObject([{ chatId: "123@c.us", chatName: "Ana", messageCount: 2, lastBody: "out", lastFromMe: true }]);
    store.close();
  });
});

// ── reconnect, backoff, breaker ─────────────────────────────────────────

describe("WhatsAppNative auto-reconnect", () => {
  it("autoStart resumes a saved session without a QR code", async () => {
    const { native, latest, clients } = harness({ session: true });
    await native.autoStart();
    expect(clients).toHaveLength(1);
    latest().handlers.onAuthenticated();
    latest().handlers.onReady();
    expect(native.snapshot()).toMatchObject({ state: "linked", qr: null });
  });

  it("autoStart without a session stays not_linked and launches nothing", async () => {
    const { native, clients } = harness();
    await native.autoStart();
    expect(native.snapshot().state).toBe("not_linked");
    expect(clients).toHaveLength(0);
  });

  it("backs off exponentially and opens the circuit after 5 consecutive failures", async () => {
    const { native, latest, timers, clients } = harness({ session: true });
    await native.autoStart();
    const delays: number[] = [];
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      latest().handlers.onDisconnected("NAVIGATION");
      const snapshot = native.snapshot();
      expect(snapshot.failures).toBe(attempt);
      if (attempt < 5) {
        expect(snapshot.circuitOpen).toBe(false);
        const delay = snapshot.nextRetryAt! - timers.now;
        delays.push(delay);
        await timers.advance(delay);
        expect(clients).toHaveLength(attempt + 1);
      }
    }
    expect(delays).toEqual([5_000, 10_000, 20_000, 40_000]);
    expect(native.snapshot()).toMatchObject({ state: "disconnected", circuitOpen: true, nextRetryAt: null });
    await timers.advance(24 * 60 * 60_000);
    expect(clients).toHaveLength(5);

    // Reconnect closes the breaker and starts over
    await native.reconnect();
    expect(clients).toHaveLength(6);
    expect(native.snapshot()).toMatchObject({ circuitOpen: false, failures: 0 });
  });

  it("a start that never produces an event counts as a failure", async () => {
    const { native, timers } = harness({ session: true });
    await native.autoStart();
    await timers.advance(180_000);
    expect(native.snapshot()).toMatchObject({ state: "disconnected", failures: 1 });
  });

  it("a ready client resets the failure count", async () => {
    const { native, latest, timers } = harness({ session: true });
    await native.autoStart();
    latest().handlers.onDisconnected("NAVIGATION");
    await timers.advance(5_000);
    latest().handlers.onReady();
    expect(native.snapshot()).toMatchObject({ state: "linked", failures: 0 });
  });
});

// ── no-send guarantee ───────────────────────────────────────────────────

describe("WhatsApp is read-only", () => {
  it("the client handed to WhatsAppNative exposes only initialize, getState and destroy", async () => {
    const seenKeys: string[][] = [];
    const { native, latest } = harness({
      loadFactory: async () => (options, handlers) => {
        const raw = new FakeRawClient();
        raw.handlers = handlers;
        raw.options = options;
        const wrapped = { initialize: () => raw.initialize(), getState: () => raw.getState(), destroy: () => raw.destroy(), goInvisible: () => raw.sendPresenceUnavailable() };
        seenKeys.push(Object.keys(wrapped).sort());
        clients.push(raw);
        return wrapped;
      },
    });
    const clients: FakeRawClient[] = [];
    await native.connect();
    clients[0].handlers.onReady();
    clients[0].handlers.onMessage(message());
    await native.probe();
    await native.reconnect();
    await native.shutdown();
    expect(seenKeys[0]).toEqual(["destroy", "getState", "goInvisible", "initialize"]);
    for (const raw of clients) {
      for (const spy of [raw.sendMessage, raw.sendSeen, raw.reply, raw.markChatUnread, raw.sendPresenceAvailable]) {
        expect(spy).not.toHaveBeenCalled();
      }
    }
    void latest;
  });

  it("no WhatsApp source calls a send, reply, seen, presence or mutation API", () => {
    const sources = [
      "whatsapp-wwebjs.ts",
      "whatsapp-native.ts",
      "whatsapp-service.ts",
      "whatsapp-store.ts",
      "whatsapp-types.ts",
      "whatsapp-browser.ts",
    ].map((name) => [name, readFileSync(join(import.meta.dirname, name), "utf8")] as const);
    const proxy = readFileSync(join(import.meta.dirname, "connector-proxy.ts"), "utf8");
    const forbidden = /\.(sendMessage|sendSeen|reply|forward|react|markChatUnread|sendPresenceAvailable|sendStateTyping|sendStateRecording|delete|archive|pin|mute|clearMessages|downloadMedia|logout)\s*\(/;
    for (const [name, text] of sources) {
      // comments may name the methods to say they are never called
      const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      expect(code, name).not.toMatch(forbidden);
      // the single allowed presence call lives in the wrapper, exactly once
      const presence = code.match(/\.sendPresenceUnavailable\s*\(/g) ?? [];
      expect(presence.length, name).toBe(name === "whatsapp-wwebjs.ts" ? 1 : 0);
    }
    // the bridge reaches native WhatsApp only through GET read routes
    expect(proxy).toMatch(/BOS_WHATSAPP_LIST_CHATS/);
    expect(proxy).not.toMatch(/BOS_WHATSAPP_(SEND|REPLY|MARK)/);
    const routes = proxy.slice(proxy.indexOf("const WHATSAPP_ROUTES"), proxy.indexOf("async function whatsappRead"));
    expect([...routes.matchAll(/path: "([a-z]+)"/g)].map((match) => match[1])).toEqual(["chats", "messages"]);
    const read = proxy.slice(proxy.indexOf("async function whatsappRead"), proxy.indexOf("interface ConnectorRequest"));
    expect(read).toMatch(/\/api\/internal\/connectors\/whatsapp\//);
    expect([...read.matchAll(/method: "([A-Z]+)"/g)].map((match) => match[1])).toEqual(["GET"]);
  });

  it("the wrapper returns only the three read-only methods from whatsapp-web.js", () => {
    const text = readFileSync(join(import.meta.dirname, "whatsapp-wwebjs.ts"), "utf8");
    const returned = text.slice(text.lastIndexOf("return {"));
    expect(returned.match(/^\s{4}(\w+):/gm)?.map((key) => key.trim().slice(0, -1))).toEqual(["initialize", "getState", "destroy", "goInvisible"]);
    const invisible = returned.slice(returned.indexOf("goInvisible:"));
    expect(invisible.slice(0, invisible.indexOf("},") + 2)).toMatch(/^goInvisible: async \(\) => \{\s*await client\.sendPresenceUnavailable\(\);\s*\},$/);
  });

  it("the internal read API refuses anything but GET", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-wa-svc-"));
    try {
      const service = new WhatsAppService({ dataDir: dir, env: {}, native: { loadFactory: async () => { throw new Error("not used"); } } });
      expect(service.handleInternal("POST", "/api/internal/connectors/whatsapp/messages", new URLSearchParams())?.status).toBe(405);
      expect(service.handleInternal("DELETE", "/api/internal/connectors/whatsapp/chats", new URLSearchParams())?.status).toBe(405);
      service.store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── tile API ────────────────────────────────────────────────────────────

describe("WhatsAppService tile API", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omb-wa-svc-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function service(env: NodeJS.ProcessEnv = {}) {
    const clients: FakeRawClient[] = [];
    const factory: CreateReadOnlyClient = (options, handlers) => {
      const raw = new FakeRawClient();
      raw.options = options;
      raw.handlers = handlers;
      clients.push(raw);
      return { initialize: () => raw.initialize(), getState: () => raw.getState(), destroy: () => raw.destroy(), goInvisible: () => raw.sendPresenceUnavailable() };
    };
    const svc = new WhatsAppService({
      dataDir: dir,
      env,
      native: {
        loadFactory: async () => factory,
        resolveBrowser: () => ({ path: "/fake/chrome", source: "google-chrome" }),
        releaseStaleProfile: () => {},
        log: () => {},
      },
    });
    return { svc, clients };
  }

  it("GET /api/whatsapp/native returns the native state; Connect and the authorize route start the client and surface the QR", async () => {
    const { svc, clients } = service();
    expect(await svc.handlePublic("GET", "/api/whatsapp/native")).toMatchObject({
      status: 200,
      body: { native: true, whatsapp: { state: "not_linked", qr: null } },
    });
    const connected = await svc.handlePublic("POST", "/api/connectors/whatsapp/authorize");
    expect(connected).toMatchObject({ status: 200, body: { native: true, whatsapp: { state: "linking" } } });
    clients[0].handlers.onQr("2@QRDATA");
    expect(await svc.handlePublic("GET", "/api/whatsapp/native")).toMatchObject({
      body: { whatsapp: { state: "qr_pending", qr: "2@QRDATA" } },
    });
    expect(svc.withNativeState({ gmail: { connected: true } })).toEqual({
      gmail: { connected: true },
      whatsapp: { connected: false, pending: true, status: "qr_pending", accounts: [] },
    });
    await svc.handlePublic("POST", "/api/whatsapp/native/connect");
    expect(clients).toHaveLength(1);
    clients[0].handlers.onReady();
    expect(svc.connectorState()).toMatchObject({ connected: true, status: "linked" });
    expect(svc.toolsAvailable()).toBe(true);
    await svc.shutdown();
  });

  it("keeps the session and database under the data dir", () => {
    const { svc } = service();
    expect(svc.paths.authDir).toBe(join(dir, "whatsapp", "auth"));
    expect(svc.paths.database).toBe(join(dir, "whatsapp", "messages.db"));
    expect(svc.native.sessionDir).toBe(join(dir, "whatsapp", "auth", "session-bos"));
    svc.store.close();
  });

  it("leaves other paths alone and hands authorize back to Composio when turned off", async () => {
    const { svc } = service({ OMB_WHATSAPP_NATIVE: "0" });
    expect(await svc.handlePublic("POST", "/api/connectors/whatsapp/authorize")).toBeNull();
    expect(await svc.handlePublic("POST", "/api/connectors/gmail/authorize")).toBeNull();
    expect(svc.withNativeState({})).toEqual({});
    expect(svc.toolsAvailable()).toBe(false);
    svc.store.close();
  });

  it("serves captured history to the read routes", async () => {
    const { svc, clients } = service();
    await svc.handlePublic("POST", "/api/whatsapp/native/connect");
    clients[0].handlers.onReady();
    clients[0].handlers.onMessage(message({ id: "x1" }));
    clients[0].handlers.onMessage(message({ id: "x2", fromMe: true, timestamp: 1_700_000_100 }));
    const answer = svc.handleInternal("GET", "/api/internal/connectors/whatsapp/messages", new URLSearchParams({ chat_id: "123@c.us", limit: "1" }));
    expect(answer).toMatchObject({ status: 200, body: { messages: [{ id: "x2", fromMe: true }] } });
    const chats = svc.handleInternal("GET", "/api/internal/connectors/whatsapp/chats", new URLSearchParams());
    expect(chats).toMatchObject({ status: 200, body: { chats: [{ chatId: "123@c.us", messageCount: 2 }] } });
    await svc.shutdown();
  });
});

// ── browser resolution ──────────────────────────────────────────────────

describe("resolveWhatsAppBrowser", () => {
  const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const base = { platform: "darwin" as const, arch: "arm64", home: "/Users/x", listDir: () => [] as string[] };

  it("prefers the env override, then Google Chrome, then the bundled headless shell, then puppeteer", () => {
    expect(resolveWhatsAppBrowser({ ...base, env: { OMB_WHATSAPP_CHROME_PATH: "/opt/chrome" }, exists: () => true }))
      .toEqual({ path: "/opt/chrome", source: "env" });
    expect(resolveWhatsAppBrowser({ ...base, env: {}, exists: (path) => path === chrome }))
      .toEqual({ path: chrome, source: "google-chrome" });
    const bundled = resolveWhatsAppBrowser({ ...base, env: { OMB_RESOURCES_PATH: "/R" }, exists: (path) => path.startsWith("/R/browser-engine") });
    expect(bundled?.source).toBe("bundled-headless-shell");
    const puppeteer = resolveWhatsAppBrowser({
      ...base,
      env: { PUPPETEER_CACHE_DIR: "/cache" },
      listDir: () => ["mac_arm-140.0.0.0"],
      exists: (path) => path.startsWith("/cache/chrome/mac_arm-140.0.0.0/chrome-mac-arm64"),
    });
    expect(puppeteer?.source).toBe("puppeteer");
  });

  it("returns null when nothing exists, including a broken override", () => {
    expect(resolveWhatsAppBrowser({ ...base, env: {}, exists: () => false })).toBeNull();
    expect(resolveWhatsAppBrowser({ ...base, env: { OMB_WHATSAPP_CHROME_PATH: "/nope" }, exists: (path) => path === chrome })).toBeNull();
  });
});
