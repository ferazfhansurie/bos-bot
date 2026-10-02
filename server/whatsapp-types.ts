// Types shared by the native WhatsApp capture (whatsapp-native.ts), its only
// whatsapp-web.js touch point (whatsapp-wwebjs.ts) and the local store.
//
// READ-ONLY BY CONSTRUCTION. ReadOnlyWhatsAppClient is the entire surface the
// rest of the server ever sees of a linked WhatsApp session: start it, stop
// it, ask whether it is alive, and go invisible (presence "unavailable", so
// this linked session does not hold the account "online" and mute the
// phone's notifications). There is no method that sends, replies,
// forwards, reacts, marks as read or changes anything on the account, and
// incoming messages arrive as plain CapturedMessage records — never as
// whatsapp-web.js Message objects, which carry reply()/forward()/react().
// whatsapp-native.test.ts pins this.

/** What the tile shows. Never a static "ready": every value is derived from a
 * client event or the liveness probe. */
export type WhatsAppLinkState =
  | "not_linked"
  | "qr_pending"
  | "linking"
  | "linked"
  | "disconnected"
  | "needs_rescan";

export interface CapturedMessage {
  /** whatsapp-web.js serialized message id (msg.id._serialized) — the dedupe key */
  id: string;
  chatId: string;
  chatName: string | null;
  from: string;
  /** group participant who wrote it; null in one-to-one chats */
  author: string | null;
  fromMe: boolean;
  /** unix seconds, as WhatsApp reports it */
  timestamp: number;
  type: string;
  body: string;
  hasMedia: boolean;
}

export interface ReadOnlyClientHandlers {
  onQr(qr: string): void;
  onAuthenticated(): void;
  onAuthFailure(message: string): void;
  onReady(): void;
  onDisconnected(reason: string): void;
  onStateChange(state: string): void;
  onMessage(message: CapturedMessage): void;
}

/** The whole client. Deliberately nothing else. */
export interface ReadOnlyWhatsAppClient {
  initialize(): Promise<void>;
  /** WAState string (CONNECTED, OPENING, CONFLICT, ...) or null when the page
   * cannot answer. Throws when the browser is gone. */
  getState(): Promise<string | null>;
  destroy(): Promise<void>;
  /** Set this session's presence to unavailable. Presence only: no message,
   * receipt or chat state is touched. */
  goInvisible(): Promise<void>;
}

export interface ReadOnlyClientOptions {
  /** directory LocalAuth keeps session-<clientId>/ under */
  authDir: string;
  clientId: string;
  /** whatsapp-web.js web version cache directory */
  cacheDir: string;
  executablePath: string;
  qrMaxRetries: number;
  deviceName: string;
}

export type CreateReadOnlyClient = (
  options: ReadOnlyClientOptions,
  handlers: ReadOnlyClientHandlers,
) => ReadOnlyWhatsAppClient;
