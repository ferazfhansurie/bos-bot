// The whatsapp-web.js wrapper against a mocked Client. The resume case: after
// an app restart LocalAuth restores the session so fast that WhatsApp Web has
// already synced (Socket.hasSynced flipped) before whatsapp-web.js registers
// its `change:hasSynced` listener inside inject(). That event never fires
// again, so neither `authenticated` nor `ready` is emitted and the capture
// sits in "linking" until the start timer gives up — on every retry.
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ReadOnlyClientHandlers } from "./whatsapp-types.ts";

interface FakePage {
  /** what Socket.hasSynced reads in the page */
  hasSynced: boolean;
  evaluate: ReturnType<typeof vi.fn>;
}

const instances: FakeClient[] = [];

class FakeClient extends EventEmitter {
  info = { wid: { _serialized: "60111111111@c.us" } };
  getNumberId = vi.fn(async (number: string) => ({ _serialized: `${number}@c.us` }));
  sendMessage = vi.fn(async () => ({ id: { _serialized: "submitted-message" } }));
  historyChat = { id: { _serialized: "60222222222@c.us" }, syncHistory: vi.fn(async () => true), fetchMessages: vi.fn(async () => [] as unknown[]) };
  getChatById = vi.fn(async () => this.historyChat);
  /** "resumed-synced": the page synced before the listener existed (the hang);
   * "resumed": the listener catches the sync during initialize();
   * "qr": no saved session */
  static mode: "resumed-synced" | "resumed" | "qr" | "slow-sync" = "resumed";
  pupPage: FakePage;
  pupBrowser = null;
  destroyed = false;
  constructor() {
    super();
    const page: FakePage = {
      hasSynced: false,
      // stands in for the page script: when the page has synced, it calls
      // the exposed onAppStateHasSyncedEvent, which emits authenticated+ready
      evaluate: vi.fn(async () => {
        if (!page.hasSynced) return false;
        this.emit("authenticated");
        this.emit("ready");
        return true;
      }),
    };
    this.pupPage = page;
    instances.push(this);
  }
  async initialize(): Promise<void> {
    if (FakeClient.mode === "resumed-synced") {
      // synced before inject() attached change:hasSynced: no event, ever
      this.pupPage.hasSynced = true;
      return;
    }
    if (FakeClient.mode === "resumed") {
      this.pupPage.hasSynced = true;
      this.emit("authenticated");
      this.emit("ready");
      return;
    }
    if (FakeClient.mode === "qr") {
      this.emit("qr", "QR-1");
      return;
    }
    // slow-sync: initialize() returns before the sync; the event comes later
  }
  async destroy(): Promise<void> {
    this.destroyed = true;
  }
  async getState(): Promise<string> {
    return "CONNECTED";
  }
  async sendPresenceUnavailable(): Promise<void> {}
}

vi.mock("whatsapp-web.js", () => ({
  default: { Client: FakeClient, LocalAuth: class {}, Chat: class {
    id: { _serialized: string }; name: string | null;
    syncHistory: () => Promise<boolean>; fetchMessages: (options: unknown) => Promise<unknown[]>;
    constructor(client: FakeClient, data: { id: { _serialized: string }; formattedTitle: string | null }) {
      this.id = data.id; this.name = data.formattedTitle;
      this.syncHistory = client.historyChat.syncHistory;
      this.fetchMessages = client.historyChat.fetchMessages;
    }
  } },
}));

const { createReadOnlyClient, EXPOSE_SETTLE_MS, guardExposeFunction, SYNCED_RESUME_CHECK_MS } = await import("./whatsapp-wwebjs.ts");

function handlers() {
  return {
    onQr: vi.fn(),
    onAuthenticated: vi.fn(),
    onAuthFailure: vi.fn(),
    onReady: vi.fn(),
    onDisconnected: vi.fn(),
    onStateChange: vi.fn(),
    onMessage: vi.fn(),
    onDropped: vi.fn(),
  } satisfies ReadOnlyClientHandlers;
}

const options = { authDir: "/tmp/never-used", clientId: "bos", executablePath: "/fake/chrome", qrMaxRetries: 5, deviceName: "BOS Bot" };

it("reply transport rechecks live authorization after recipient lookups and sends no seen receipt", async () => {
  const wrapped = createReadOnlyClient(options, handlers());
  const raw = instances.at(-1)!;
  const input = { account_id: "60111111111@c.us", chat_id: "60222222222@c.us", message_id: "inbound", text: "hello" };
  await expect(wrapped.replies!.reply(input, () => false)).rejects.toThrow("revoked");
  expect(raw.sendMessage).not.toHaveBeenCalled();
  await expect(wrapped.replies!.reply(input, () => true)).resolves.toBe("submitted-message");
  expect(raw.sendMessage).toHaveBeenCalledWith(input.chat_id, input.text, { sendSeen: false, quotedMessageId: "inbound" });
  raw.info.wid._serialized = "60333333333@c.us";
  await expect(wrapped.replies!.reply(input, () => true)).rejects.toThrow("account changed");
  expect(raw.sendMessage).toHaveBeenCalledTimes(1);
});

it("history uses the documented sync/fetch path, verifies the account and never sends", async () => {
  const wrapped = createReadOnlyClient(options, handlers());
  const raw = instances.at(-1)!;
  expect(await wrapped.history!.sync("60222222222@c.us", "60111111111@c.us", () => true)).toEqual({ requested: true, messages: [] });
  expect(raw.historyChat.syncHistory).toHaveBeenCalledTimes(1);
  expect(raw.historyChat.fetchMessages).toHaveBeenCalledWith({ limit: 200 });
  expect(raw.sendMessage).not.toHaveBeenCalled();
  await expect(wrapped.history!.sync("60222222222@c.us", "60111111111@c.us", () => false)).rejects.toMatchObject({ status: 403, stage: "account_or_scope_changed" });
  expect(raw.historyChat.syncHistory).toHaveBeenCalledTimes(1);
});

it("history fetch still works when peer sync fails, and lookup failures are not permission errors", async () => {
  const wrapped = createReadOnlyClient(options, handlers());
  const raw = instances.at(-1)!;
  raw.historyChat.syncHistory.mockRejectedValueOnce(new Error("provider implementation unavailable"));
  expect(await wrapped.history!.sync("60222222222@c.us", "60111111111@c.us", () => true)).toEqual({ requested: false, messages: [], warning: "peer_history_request_failed" });
  expect(raw.historyChat.fetchMessages).toHaveBeenCalledWith({ limit: 200 });
  raw.getChatById.mockRejectedValueOnce(new Error("provider lookup failed"));
  raw.pupPage.evaluate.mockRejectedValueOnce(new Error("raw lookup also unavailable"));
  await expect(wrapped.history!.sync("60222222222@c.us", "60111111111@c.us", () => true)).rejects.toMatchObject({ status: 502, stage: "history_chat_lookup" });
  expect(raw.sendMessage).not.toHaveBeenCalled();
});

it("recovers only the exact group's messages when last-message metadata lookup breaks", async () => {
  const wrapped = createReadOnlyClient(options, handlers());
  const raw = instances.at(-1)!;
  const group = "120363431027070091@g.us";
  raw.getChatById.mockRejectedValueOnce(new Error("IndexedDB get(undefined)"));
  raw.pupPage.evaluate.mockResolvedValueOnce({ id: { _serialized: group }, formattedTitle: "fixture client group" });
  const getChat = vi.fn(async () => { throw new Error("metadata lookup must not run again"); });
  raw.historyChat.fetchMessages.mockResolvedValueOnce([{ id: { id: "ABC", fromMe: false, remote: { _serialized: group }, $1: `false_${group}_ABC` }, from: group, fromMe: false, timestamp: Date.now() / 1000, type: "chat", body: "fixture history", hasMedia: false, getChat }]);
  const result = await wrapped.history!.sync(group, "60111111111@c.us", () => true);
  expect(result.messages).toHaveLength(1);
  expect(result.messages[0]).toMatchObject({ chatId: group, chatName: "fixture client group", accountId: "60111111111@c.us", id: `false_${group}_ABC` });
  expect(getChat).not.toHaveBeenCalled();
  expect(raw.sendMessage).not.toHaveBeenCalled();
  expect(raw.pupPage.evaluate.mock.calls[0][0]).toContain(JSON.stringify(group));
  expect(raw.pupPage.evaluate.mock.calls[0][0]).toContain("getAsModel: false");
});

describe("createReadOnlyClient resume", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    instances.length = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a resumed session that synced before whatsapp-web.js listened still reaches ready", async () => {
    FakeClient.mode = "resumed-synced";
    const h = handlers();
    const client = createReadOnlyClient(options, h);
    const started = client.initialize();
    await vi.advanceTimersByTimeAsync(SYNCED_RESUME_CHECK_MS);
    await started;
    expect(h.onAuthenticated).toHaveBeenCalledTimes(1);
    expect(h.onReady).toHaveBeenCalledTimes(1);
  });

  it("does not touch the page when the sync event arrived on its own", async () => {
    FakeClient.mode = "resumed";
    const h = handlers();
    const client = createReadOnlyClient(options, h);
    const started = client.initialize();
    await vi.advanceTimersByTimeAsync(SYNCED_RESUME_CHECK_MS);
    await started;
    expect(h.onReady).toHaveBeenCalledTimes(1);
    expect(instances[0].pupPage.evaluate).not.toHaveBeenCalled();
  });

  it("leaves a QR flow alone", async () => {
    FakeClient.mode = "qr";
    const h = handlers();
    const client = createReadOnlyClient(options, h);
    const started = client.initialize();
    await vi.advanceTimersByTimeAsync(SYNCED_RESUME_CHECK_MS);
    await started;
    expect(h.onQr).toHaveBeenCalledWith("QR-1");
    expect(instances[0].pupPage.evaluate).not.toHaveBeenCalled();
    expect(h.onReady).not.toHaveBeenCalled();
  });

  it("a page still syncing is left to emit ready itself", async () => {
    FakeClient.mode = "slow-sync";
    const h = handlers();
    const client = createReadOnlyClient(options, h);
    const started = client.initialize();
    await vi.advanceTimersByTimeAsync(SYNCED_RESUME_CHECK_MS);
    await started;
    expect(instances[0].pupPage.evaluate).toHaveBeenCalledTimes(1);
    expect(h.onReady).not.toHaveBeenCalled();
  });

  it("a client destroyed during the grace period is not poked", async () => {
    FakeClient.mode = "resumed-synced";
    const h = handlers();
    const client = createReadOnlyClient(options, h);
    const started = client.initialize();
    await client.destroy();
    await vi.advanceTimersByTimeAsync(SYNCED_RESUME_CHECK_MS);
    await started;
    expect(instances[0].pupPage.evaluate).not.toHaveBeenCalled();
    expect(h.onReady).not.toHaveBeenCalled();
  });
});

// WhatsApp Web's cross-origin pdf-viewer iframe swaps process while puppeteer
// installs a binding in it; that frame never answers and exposeFunction never
// settles, so whatsapp-web.js stalls in attachEventListeners short of `ready`.
describe("guardExposeFunction", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function page(mainFrameHasIt: boolean) {
    return {
      exposeFunction: vi.fn((_name: string, _fn: unknown) => new Promise<void>(() => {})),
      evaluate: vi.fn(async (_fn: unknown) => mainFrameHasIt),
    };
  }

  it("carries on once the main frame has the function, even if a frame never answers", async () => {
    const p = page(true);
    guardExposeFunction(p);
    let done = false;
    void p.exposeFunction("onMessageAckEvent", () => {}).then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(EXPOSE_SETTLE_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
    expect(String(p.evaluate.mock.calls[0][0])).toContain("puppeteer_onMessageAckEvent");
  });

  it("keeps waiting while the main frame does not have it yet", async () => {
    const p = page(false);
    guardExposeFunction(p);
    let done = false;
    void p.exposeFunction("onMessageAckEvent", () => {}).then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(3 * EXPOSE_SETTLE_MS);
    expect(done).toBe(false);
  });

  it("passes a normal expose and its errors straight through, once per page", async () => {
    const ok = { exposeFunction: vi.fn(async (_name: string, _fn: unknown) => {}), evaluate: vi.fn() };
    guardExposeFunction(ok);
    const wrapped = ok.exposeFunction;
    guardExposeFunction(ok);
    expect(ok.exposeFunction).toBe(wrapped);
    await expect(ok.exposeFunction("a", () => {})).resolves.toBeUndefined();
    const bad = { exposeFunction: vi.fn(async (_name: string, _fn: unknown): Promise<void> => { throw new Error("Target closed"); }), evaluate: vi.fn() };
    guardExposeFunction(bad);
    await expect(bad.exposeFunction("a", () => {})).rejects.toThrow("Target closed");
    expect(ok.evaluate).not.toHaveBeenCalled();
  });
});
