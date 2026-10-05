// The ONLY module that touches whatsapp-web.js. It is loaded lazily by path
// (whatsapp-native.ts → loadReadOnlyClientFactory) and, in the packaged app,
// bundled on its own by scripts/bundle-server.mjs into
// dist-server/whatsapp-wwebjs.js with whatsapp-web.js + puppeteer inlined —
// the packaged app ships no node_modules.
//
// READ-ONLY. The raw whatsapp-web.js Client never leaves this function's
// closure. What is returned is a three-method object (initialize, getState,
// destroy) and incoming messages are copied into plain CapturedMessage
// records before they leave, so no caller can ever reach the Message/Chat
// methods that write to the account. Do not add a passthrough here: the
// no-send test in whatsapp-native.test.ts scans this file.
import wwebjs from "whatsapp-web.js";

import { captureFields, serializedWid } from "./whatsapp-capture.ts";
import type {
  CapturedMessage,
  ReadOnlyClientHandlers,
  ReadOnlyClientOptions,
  ReadOnlyWhatsAppClient,
} from "./whatsapp-types.ts";

const { Client, LocalAuth } = wwebjs;

const CHAT_NAME_TTL_MS = 10 * 60_000;
/** a chat lookup that takes longer than this stores the message without a name */
const CHAT_LOOKUP_TIMEOUT_MS = 5_000;
/** how long after initialize() a resume that produced no lifecycle event is
 * checked for an already-synced page */
export const SYNCED_RESUME_CHECK_MS = 3_000;
/** Page script: if WhatsApp Web has already synced, run whatsapp-web.js's own
 * exposed sync handler (it emits authenticated, then ready). A string, like
 * whatsapp-web.js's own probes: it runs in the page, not in Node. */
const SYNCED_RESUME_SCRIPT = `(() => {
  const socket = window.require("WAWebSocketModel").Socket;
  if (socket.hasSynced !== true || typeof window.onAppStateHasSyncedEvent !== "function") return false;
  window.onAppStateHasSyncedEvent();
  return true;
})()`;

type RawMessage = wwebjs.Message;

export function createReadOnlyClient(
  options: ReadOnlyClientOptions,
  handlers: ReadOnlyClientHandlers,
): ReadOnlyWhatsAppClient {
  const client = new Client({
    authStrategy: new LocalAuth({ clientId: options.clientId, dataPath: options.authDir }),
    // No version cache: a cached index turns on puppeteer request
    // interception, and with it a resumed session stalled inside
    // whatsapp-web.js's listener setup and never reached `ready`.
    webVersionCache: { type: "none" },
    qrMaxRetries: options.qrMaxRetries,
    deviceName: options.deviceName,
    // never take the session away from another open WhatsApp Web tab
    takeoverOnConflict: false,
    puppeteer: {
      headless: true,
      executablePath: options.executablePath,
      args: [
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-features=Translate,MediaRouter",
        "--mute-audio",
        // a real Google Chrome binary must not prompt for the login keychain
        "--use-mock-keychain",
        "--password-store=basic",
      ],
    },
  });

  const chatNames = new Map<string, { name: string | null; chatId: string; at: number }>();
  async function chatOf(message: RawMessage, fallbackId: string): Promise<{ chatId: string; chatName: string | null }> {
    const cached = chatNames.get(fallbackId);
    if (cached && Date.now() - cached.at < CHAT_NAME_TTL_MS) return { chatId: cached.chatId, chatName: cached.name };
    let timer: NodeJS.Timeout | null = null;
    try {
      // getChat() reads the chat model from the page. It does not mark the
      // chat as seen (only Chat.sendSeen / Client.sendSeen do, never called).
      const chat = await Promise.race([
        message.getChat(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("chat lookup timed out")), CHAT_LOOKUP_TIMEOUT_MS);
        }),
      ]);
      const entry = { chatId: serializedWid(chat.id) || fallbackId, name: chat.name || null, at: Date.now() };
      chatNames.set(fallbackId, entry);
      return { chatId: entry.chatId, chatName: entry.name };
    } catch {
      return { chatId: fallbackId, chatName: cached?.name ?? null };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function capture(message: RawMessage): Promise<CapturedMessage | null> {
    const fields = captureFields(message);
    if (fields.skip !== null) {
      if (!fields.expected) handlers.onDropped(fields.skip);
      return null;
    }
    const { chatId, chatName } = await chatOf(message, fields.fallbackChatId);
    return { ...fields.message, chatId, chatName };
  }

  // any of these means whatsapp-web.js's auth flow is moving on its own
  let lifecycleSeen = false;
  let destroyed = false;
  client.on("qr", (qr: string) => {
    lifecycleSeen = true;
    handlers.onQr(qr);
  });
  client.on("authenticated", () => {
    lifecycleSeen = true;
    handlers.onAuthenticated();
  });
  client.on("auth_failure", (message: unknown) => handlers.onAuthFailure(String(message ?? "authentication failed")));
  client.on("ready", () => {
    lifecycleSeen = true;
    handlers.onReady();
  });
  client.on("disconnected", (reason: unknown) => handlers.onDisconnected(String(reason ?? "disconnected")));
  client.on("change_state", (state: unknown) => handlers.onStateChange(String(state ?? "")));
  // message_create fires for received messages AND for messages the user
  // sends from the phone or another linked device. It is the one capture
  // listener; the store dedupes by serialized id.
  client.on("message_create", (message: RawMessage) => {
    void capture(message).then((captured) => {
      if (captured) handlers.onMessage(captured);
    }).catch((error: unknown) => handlers.onDropped(`capture failed: ${error instanceof Error ? error.message : String(error)}`));
  });

  /** whatsapp-web.js attaches its `change:hasSynced` listener only at the end
   * of inject(). A session LocalAuth restores at boot can finish syncing
   * before that, and the event never fires again: no authenticated, no
   * ready, and every retry stalls the same way. Once initialize() has
   * returned and nothing happened for a short grace period, ask the page
   * whether it has already synced and, if so, run the handler it missed. */
  async function resumeIfAlreadySynced(): Promise<void> {
    if (lifecycleSeen || destroyed) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, SYNCED_RESUME_CHECK_MS);
      timer.unref?.();
    });
    const page = client.pupPage;
    if (lifecycleSeen || destroyed || !page) return;
    try {
      await page.evaluate(SYNCED_RESUME_SCRIPT);
    } catch {
      // the page went away: the start timer and probe in whatsapp-native.ts
      // turn that into a retry
    }
  }

  return {
    initialize: async () => {
      await client.initialize();
      await resumeIfAlreadySynced();
    },
    getState: async () => {
      const state = await client.getState();
      return state ? String(state) : null;
    },
    destroy: () => {
      destroyed = true;
      return client.destroy();
    },
    // The single presence call. An online WhatsApp Web session mutes the
    // phone's notifications; "unavailable" keeps them ringing. It sends no
    // message, receipt or typing state.
    goInvisible: async () => {
      await client.sendPresenceUnavailable();
    },
    browserPid: () => {
      try {
        return client.pupBrowser?.process()?.pid ?? null;
      } catch {
        return null;
      }
    },
  };
}
