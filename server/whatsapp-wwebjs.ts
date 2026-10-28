// The ONLY module that touches whatsapp-web.js. It is loaded lazily by path
// (whatsapp-native.ts → loadReadOnlyClientFactory) and, in the packaged app,
// bundled on its own by scripts/bundle-server.mjs into
// dist-server/whatsapp-wwebjs.js with whatsapp-web.js + puppeteer inlined —
// the packaged app ships no node_modules.
//
// The raw Client stays in this closure. Capture emits plain records; history
// and replies expose narrow operations with account and live-authorization
// checks. Replies are reachable only through the owner-configured server gate.
import wwebjs from "whatsapp-web.js";

import { captureFields, serializedMessageId, serializedWid } from "./whatsapp-capture.ts";
import { historyStage, WhatsAppHistoryError } from "./whatsapp-history.ts";
import type {
  CapturedMessage,
  ReadOnlyClientHandlers,
  ReadOnlyClientOptions,
  ReadOnlyWhatsAppClient,
} from "./whatsapp-types.ts";

const { Client, LocalAuth } = wwebjs;
type HistoryChat = Pick<wwebjs.Chat, "id" | "name" | "fetchMessages" | "syncHistory">;
const RuntimeChat = (wwebjs as unknown as { Chat: new (client: wwebjs.Client, data: unknown) => HistoryChat }).Chat;

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

/** an exposeFunction still pending after this is checked in the main frame */
export const EXPOSE_SETTLE_MS = 10_000;
/** Page script: the main frame has both the exposed function and the CDP
 * binding behind it (puppeteer names it puppeteer_<name>). */
const exposedInMainFrame = (name: string) => `(() => typeof window[${JSON.stringify(name)}] === "function" && typeof window[${JSON.stringify(`puppeteer_${name}`)}] === "function")()`;

type ExposingPage = {
  exposeFunction(name: string, fn: unknown): Promise<void>;
  evaluate(script: string): Promise<unknown>;
  __bosExposeGuard?: true;
};

/** puppeteer's exposeFunction installs the binding in every frame and waits
 * for all of them. WhatsApp Web opens a cross-origin pdf-viewer iframe that
 * swaps process mid-install; the iframe's Runtime.addBinding never gets an
 * answer, exposeFunction never settles, whatsapp-web.js stops halfway through
 * attachEventListeners and `ready` never fires. Only the main frame matters:
 * once it has the function, carry on. */
export function guardExposeFunction(page: ExposingPage | null | undefined, settleMs = EXPOSE_SETTLE_MS): void {
  if (!page || page.__bosExposeGuard) return;
  page.__bosExposeGuard = true;
  const expose = page.exposeFunction.bind(page);
  page.exposeFunction = (name, fn) => new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearInterval(check);
      if (error) reject(error);
      else resolve();
    };
    const check = setInterval(() => {
      void page.evaluate(exposedInMainFrame(name)).then((ok) => {
        if (ok === true) finish();
      }, () => {});
    }, settleMs);
    check.unref?.();
    expose(name, fn).then(() => finish(), finish);
  });
}

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
        // site-per-process + IsolateOrigins: keep WhatsApp's cross-origin
        // iframes in the page's own process, so puppeteer never attaches to
        // them as separate targets (see guardExposeFunction for what that
        // does to startup)
        "--disable-features=Translate,MediaRouter,site-per-process,IsolateOrigins",
        "--disable-site-isolation-trials",
        "--mute-audio",
        // a real Google Chrome binary must not prompt for the login keychain
        "--use-mock-keychain",
        "--password-store=basic",
      ],
    },
  });
  // inject() runs at start and again after every page reload; guard the page
  // it is about to install whatsapp-web.js's listeners on
  const raw = client as unknown as { inject?: () => Promise<void>; pupPage: ExposingPage | null };
  if (typeof raw.inject === "function") {
    const inject = raw.inject.bind(client);
    raw.inject = async () => {
      guardExposeFunction(raw.pupPage);
      return inject();
    };
  }

  const chatNames = new Map<string, { name: string | null; chatId: string; at: number }>();
  const historyImportedBefore = new Map<string, number>();
  async function chatOf(message: RawMessage, fallbackId: string): Promise<{ chatId: string; chatName: string | null }> {
    const cached = chatNames.get(fallbackId);
    if (cached && Date.now() - cached.at < CHAT_NAME_TTL_MS) return { chatId: cached.chatId, chatName: cached.name };
    // message.getChat() serializes the full chat model, which throws an
    // IndexedDB DataError on current WhatsApp Web and left nearly every
    // captured chat unnamed. The plain lookup (as in reply()) still works.
    try {
      const titled = (await chatTitles([fallbackId]))[fallbackId];
      if (titled) {
        chatNames.set(fallbackId, { chatId: fallbackId, name: titled, at: Date.now() });
        return { chatId: fallbackId, chatName: titled };
      }
    } catch { /* fall back to the model lookup below */ }
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

  /** Display titles (contact/group name) for exact chat ids, read from the
   * page's chat collection without serializing chat models or creating chats.
   * Missing chats are left out. */
  async function chatTitles(chatIds: string[]): Promise<Record<string, string>> {
    const page = client.pupPage;
    const ids = chatIds.filter((id) => /^(\d{6,20}@c\.us|\d{6,25}@lid|[\d-]{6,40}@g\.us)$/.test(id)).slice(0, 200);
    if (!page || !ids.length) return {};
    let timer: NodeJS.Timeout | null = null;
    try {
      const found = await Promise.race([
        page.evaluate(`(async () => {
          const out = {};
          const chats = window.require("WAWebCollections").Chat;
          const wid = window.require("WAWebWidFactory");
          for (const id of ${JSON.stringify(ids)}) {
            try {
              // Chat.get only reads loaded chats; WWebJS.getChat may create one.
              const c = chats.get(wid.createWid(id));
              if (!c || !c.id || c.id._serialized !== id) continue;
              const contact = c.contact || {};
              const title = c.formattedTitle || c.name || contact.name || contact.pushname || contact.verifiedName || null;
              if (typeof title === "string" && title.trim()) out[id] = title.trim().slice(0, 120);
            } catch {}
          }
          return out;
        })()`),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("chat titles timed out")), CHAT_LOOKUP_TIMEOUT_MS * 2);
        }),
      ]) as Record<string, unknown>;
      const titles: Record<string, string> = {};
      for (const id of ids) if (typeof found?.[id] === "string") titles[id] = found[id] as string;
      return titles;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function capture(message: RawMessage, knownChat?: { chatId: string; chatName: string | null }): Promise<CapturedMessage | null> {
    const accountId = serializedWid(client.info?.wid);
    const fields = captureFields(message);
    if (fields.skip !== null) {
      if (!fields.expected) handlers.onDropped(fields.skip);
      return null;
    }
    if (knownChat && fields.fallbackChatId !== knownChat.chatId) return null;
    const { chatId, chatName } = knownChat ?? await chatOf(message, fields.fallbackChatId);
    if (accountId !== serializedWid(client.info?.wid)) return null;
    return { ...fields.message, chatId, chatName, accountId, ...(fields.message.timestamp <= (historyImportedBefore.get(chatId) ?? 0) ? { importedHistory: true } : {}) };
  }

  async function historyChatFor(chatId: string): Promise<HistoryChat> {
    try {
      const chat = await historyStage("chat_lookup", () => client.getChatById(chatId));
      if (!chat || serializedWid(chat.id) !== chatId) throw new WhatsAppHistoryError(502, "chat_lookup");
      return chat;
    }
    catch (error) {
      // wwebjs 1.34.7 getChatModel queries lastReceivedKey._serialized;
      // newer WA uses $1, causing IndexedDB get(undefined). The SDK's own
      // fetchMessages uses getAsModel:false and avoids this metadata path.
      // Read only the requested chat's id/title and use the exported SDK
      // Chat methods; no injected model mutation or all-chat enumeration.
      const page = client.pupPage;
      if (!page) throw error;
      const data = await historyStage("history_chat_lookup", () => page.evaluate(`(async () => {
        const chat = await window.WWebJS.getChat(${JSON.stringify(chatId)}, { getAsModel: false });
        if (!chat) return null;
        return { id: { _serialized: chat.id._serialized }, formattedTitle: chat.formattedTitle || null };
      })()`)) as { id: { _serialized: string }; formattedTitle: string | null } | null;
      if (!data || serializedWid(data.id) !== chatId) throw new WhatsAppHistoryError(403, "account_or_scope_changed");
      return new RuntimeChat(client, data);
    }
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
    history: {
      accountId: () => serializedWid(client.info?.wid) || null,
      titles: (chatIds) => chatTitles(chatIds),
      sync: async (chatId, accountId, authorized) => {
        if (serializedWid(client.info?.wid) !== accountId || !authorized()) throw new WhatsAppHistoryError(403, "account_or_scope_changed");
        const chat = await historyChatFor(chatId);
        if (serializedWid(chat.id) !== chatId || serializedWid(client.info?.wid) !== accountId || !authorized()) throw new WhatsAppHistoryError(403, "account_or_scope_changed");
        // Loading earlier messages can emit message_create. Capture them,
        // but suppress event-driven replies for messages predating the load.
        historyImportedBefore.set(chatId, Date.now() / 1000);
        // A peer-history request can be unsupported even while fetching the
        // existing chat works. Still recover available history, honestly.
        let requested = false;
        let warning: string | undefined;
        try { requested = await chat.syncHistory(); }
        catch { warning = "peer_history_request_failed"; }
        if (serializedWid(client.info?.wid) !== accountId || !authorized()) throw new WhatsAppHistoryError(403, "account_or_scope_changed");
        const raw = await historyStage("fetch_messages", () => chat.fetchMessages({ limit: 200 }));
        const messages = (await historyStage("capture_messages", () => Promise.all(raw.map(message => capture(message, { chatId, chatName: chat.name || null }))))).filter((m): m is CapturedMessage => !!m);
        if (serializedWid(client.info?.wid) !== accountId || !authorized()) throw new WhatsAppHistoryError(403, "account_or_scope_changed");
        return { requested, messages, ...(warning ? { warning } : {}) };
      },
    },
    replies: {
      accountId: () => serializedWid(client.info?.wid) || null,
      reply: async (input, authorized) => {
        if (serializedWid(client.info?.wid) !== input.account_id) throw new Error("WhatsApp account changed");
        // getChatById serializes the full chat model, which throws an IndexedDB DataError on
        // current WhatsApp Web; the plain lookup is the same one sendMessage uses.
        const recipient = input.chat_id.endsWith("@c.us") ? await client.getNumberId(input.chat_id.split("@")[0]) : await client.pupPage!.evaluate(`(async () => { const c = await window.WWebJS.getChat(${JSON.stringify(input.chat_id)}, { getAsModel: false }); return c && c.id ? c.id._serialized : null; })()`);
        if (await client.getState() !== "CONNECTED" || serializedWid(recipient) !== input.chat_id || serializedWid(client.info?.wid) !== input.account_id) throw new Error("WhatsApp account or recipient mismatch");
        if (!authorized()) throw new Error("WhatsApp reply authorization revoked");
        const sent = await client.sendMessage(input.chat_id, input.text, { sendSeen: false, ...(input.message_id ? { quotedMessageId: input.message_id } : {}) });
        return serializedMessageId(sent.id) ?? "";
      },
    },
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
    screenshot: async () => {
      const page = client.pupPage;
      if (!page) return null;
      return await page.screenshot({ type: "jpeg", quality: 60 }) as Uint8Array;
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
