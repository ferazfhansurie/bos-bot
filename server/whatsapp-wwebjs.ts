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

import type {
  CapturedMessage,
  ReadOnlyClientHandlers,
  ReadOnlyClientOptions,
  ReadOnlyWhatsAppClient,
} from "./whatsapp-types.ts";

const { Client, LocalAuth } = wwebjs;

/** WhatsApp Status updates are not conversations; they are not captured. */
const STATUS_BROADCAST = "status@broadcast";
const CHAT_NAME_TTL_MS = 10 * 60_000;

type RawMessage = wwebjs.Message;

export function createReadOnlyClient(
  options: ReadOnlyClientOptions,
  handlers: ReadOnlyClientHandlers,
): ReadOnlyWhatsAppClient {
  const client = new Client({
    authStrategy: new LocalAuth({ clientId: options.clientId, dataPath: options.authDir }),
    webVersionCache: { type: "local", path: options.cacheDir },
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
    try {
      // getChat() reads the chat model from the page. It does not mark the
      // chat as seen (only Chat.sendSeen / Client.sendSeen do, never called).
      const chat = await message.getChat();
      const entry = { chatId: chat.id._serialized || fallbackId, name: chat.name || null, at: Date.now() };
      chatNames.set(fallbackId, entry);
      return { chatId: entry.chatId, chatName: entry.name };
    } catch {
      return { chatId: fallbackId, chatName: cached?.name ?? null };
    }
  }

  async function capture(message: RawMessage): Promise<CapturedMessage | null> {
    const id = message.id?._serialized;
    if (!id) return null;
    const fallbackChatId = message.fromMe ? message.to : message.from;
    if (!fallbackChatId || fallbackChatId === STATUS_BROADCAST || message.from === STATUS_BROADCAST) return null;
    const { chatId, chatName } = await chatOf(message, fallbackChatId);
    return {
      id,
      chatId,
      chatName,
      from: message.from ?? "",
      author: message.author ?? null,
      fromMe: message.fromMe === true,
      timestamp: Number(message.timestamp) || Math.floor(Date.now() / 1000),
      type: String(message.type ?? "unknown"),
      body: typeof message.body === "string" ? message.body : "",
      hasMedia: message.hasMedia === true,
    };
  }

  client.on("qr", (qr: string) => handlers.onQr(qr));
  client.on("authenticated", () => handlers.onAuthenticated());
  client.on("auth_failure", (message: unknown) => handlers.onAuthFailure(String(message ?? "authentication failed")));
  client.on("ready", () => handlers.onReady());
  client.on("disconnected", (reason: unknown) => handlers.onDisconnected(String(reason ?? "disconnected")));
  client.on("change_state", (state: unknown) => handlers.onStateChange(String(state ?? "")));
  // message_create fires for received messages AND for messages the user
  // sends from the phone or another linked device. It is the one capture
  // listener; the store dedupes by serialized id.
  client.on("message_create", (message: RawMessage) => {
    void capture(message).then((captured) => {
      if (captured) handlers.onMessage(captured);
    }).catch(() => {});
  });

  return {
    initialize: () => client.initialize(),
    getState: async () => {
      const state = await client.getState();
      return state ? String(state) : null;
    },
    destroy: () => client.destroy(),
    // The single presence call. An online WhatsApp Web session mutes the
    // phone's notifications; "unavailable" keeps them ringing. It sends no
    // message, receipt or typing state.
    goInvisible: async () => {
      await client.sendPresenceUnavailable();
    },
  };
}
