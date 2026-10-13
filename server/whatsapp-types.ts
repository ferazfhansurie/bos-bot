// Types shared by the native WhatsApp capture (whatsapp-native.ts), its only
// whatsapp-web.js touch point (whatsapp-wwebjs.ts) and the local store.
//
// Capture hands callers plain records, never raw Message objects. The client
// keeps the raw session private and exposes only narrow lifecycle, history and
// reply transports. The server checks owner policy, account, recipient and
// active turn authorization before invoking the optional reply transport.
// Default bot grants still expose reading/history only.

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
  /** Linked account which captured this message. Unknown historic rows are
   * excluded from client-scoped reads and autonomous replies. */
  accountId?: string | null;
  /** A history load may emit message_create; never dispatch replies to it. */
  importedHistory?: boolean;
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
  /** a message that arrived but could not be captured, and why (never its content) */
  onDropped(reason: string): void;
}

/** The whole client. Deliberately nothing else. */
export interface ReadOnlyWhatsAppClient {
  history?: { accountId(): string | null; sync(chatId: string, accountId: string, authorized: () => boolean): Promise<{ requested: boolean; messages: CapturedMessage[]; warning?: string }> };
  /** Narrow transport used only behind the owner-configured reply policy. */
  replies?: import("./whatsapp-replies.ts").ReplyTransport;
  initialize(): Promise<void>;
  /** WAState string (CONNECTED, OPENING, CONFLICT, ...) or null when the page
   * cannot answer. Throws when the browser is gone. */
  getState(): Promise<string | null>;
  destroy(): Promise<void>;
  /** Set this session's presence to unavailable. Presence only: no message,
   * receipt or chat state is touched. */
  goInvisible(): Promise<void>;
  /** pid of this client's own Chromium, if launched — used only to force-kill
   * that one process when destroy() hangs */
  browserPid(): number | null;
}

export interface ReadOnlyClientOptions {
  /** directory LocalAuth keeps session-<clientId>/ under */
  authDir: string;
  clientId: string;
  executablePath: string;
  qrMaxRetries: number;
  deviceName: string;
}

export type CreateReadOnlyClient = (
  options: ReadOnlyClientOptions,
  handlers: ReadOnlyClientHandlers,
) => ReadOnlyWhatsAppClient;
