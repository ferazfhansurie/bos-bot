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
  default: { Client: FakeClient, LocalAuth: class {} },
}));

const { createReadOnlyClient, SYNCED_RESUME_CHECK_MS } = await import("./whatsapp-wwebjs.ts");

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
