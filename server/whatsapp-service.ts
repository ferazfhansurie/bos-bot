import { compatEnv, compatEnvironment } from "../electron/branding-env.cjs";
// Native WhatsApp wired for the server: one WhatsAppNative + its store under
// <data dir>/whatsapp/, the HTTP surface the Connected apps tile uses, and the
// read-only routes the connector bridge (connector-proxy.ts) calls for bots.
//
// The tile keeps the Composio catalog's `whatsapp` slug; only its connect flow
// and status come from here. Existing Composio WhatsApp connections are never
// read, changed or removed by this module.
import { join } from "node:path";

import type { ConnectorServiceState } from "./composio.ts";
import { noBrowserReason, resolveWhatsAppBrowser } from "./whatsapp-browser.ts";
import {
  loadReadOnlyClientFactory,
  WhatsAppNative,
  type WhatsAppNativeOptions,
  type WhatsAppNativeSnapshot,
} from "./whatsapp-native.ts";
import { WhatsAppStore } from "./whatsapp-store.ts";

export const WHATSAPP_SLUG = "whatsapp";
export const WHATSAPP_CLIENT_ID = "bos";

export const WHATSAPP_NATIVE_PROMPT =
  " The user's WhatsApp is linked to this Mac read-only. Read captured chats with BOS_WHATSAPP_LIST_CHATS and messages with BOS_WHATSAPP_LIST_MESSAGES (newest first; filter by chat_id, before, or query). You cannot send, reply to, or mark WhatsApp messages as read — say so if asked.";

export interface WhatsAppPaths {
  root: string;
  authDir: string;
  database: string;
}

export function whatsappPaths(dataDir: string): WhatsAppPaths {
  const root = join(dataDir, "whatsapp");
  return {
    root,
    authDir: join(root, "auth"),
    database: join(root, "messages.db"),
  };
}

export interface HttpAnswer {
  status: number;
  body: unknown;
}

export interface WhatsAppServiceOptions {
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  /** test seam: everything WhatsAppNative accepts, over the real defaults */
  native?: Partial<WhatsAppNativeOptions>;
}

export function connectorStateFor(snapshot: WhatsAppNativeSnapshot): ConnectorServiceState {
  return {
    connected: snapshot.state === "linked",
    pending: snapshot.state === "qr_pending" || snapshot.state === "linking",
    status: snapshot.state,
    accounts: [],
  };
}

const intParam = (value: string | null): number | undefined => {
  if (value === null || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

export class WhatsAppService {
  readonly enabled: boolean;
  readonly paths: WhatsAppPaths;
  readonly store: WhatsAppStore;
  readonly native: WhatsAppNative;

  constructor(options: WhatsAppServiceOptions) {
    const env = options.env ?? compatEnv;
    // OMB_WHATSAPP_NATIVE=0 turns the whole feature off (the tile falls back
    // to the generic Composio flow and nothing auto-starts).
    this.enabled = compatEnvironment(env).OMB_WHATSAPP_NATIVE !== "0";
    this.paths = whatsappPaths(options.dataDir);
    this.store = new WhatsAppStore(this.paths.database);
    this.native = new WhatsAppNative({
      authDir: this.paths.authDir,
      clientId: WHATSAPP_CLIENT_ID,
      loadFactory: loadReadOnlyClientFactory,
      resolveBrowser: () => resolveWhatsAppBrowser({ env }),
      noBrowserReason: () => noBrowserReason(env),
      store: this.store,
      ...options.native,
    });
  }

  autoStart(): Promise<void> {
    return this.enabled ? this.native.autoStart() : Promise.resolve();
  }

  async shutdown(): Promise<void> {
    await this.native.shutdown();
    this.store.close();
  }

  /** Mount the read tools for a bot whose Connected-apps grant is on: while
   * linked, or whenever there is captured history to read. */
  toolsAvailable(): boolean {
    if (!this.enabled) return false;
    if (this.native.snapshot().state === "linked") return true;
    try {
      return this.store.count() > 0;
    } catch {
      return false;
    }
  }

  /** The tile's status entry; overrides whatever Composio says for the slug. */
  connectorState(): ConnectorServiceState | null {
    return this.enabled ? connectorStateFor(this.native.snapshot()) : null;
  }

  /** Overlay the native state onto a Composio services map (a new object). */
  withNativeState<T extends Record<string, unknown>>(services: T): T {
    const state = this.connectorState();
    return state ? { ...services, [WHATSAPP_SLUG]: state } : services;
  }

  /** Public UI routes. Null when the path is not ours. */
  async handlePublic(method: string, path: string): Promise<HttpAnswer | null> {
    const native = path === "/api/whatsapp/native" || path.startsWith("/api/whatsapp/native/");
    const authorize = path === `/api/connectors/${WHATSAPP_SLUG}/authorize`;
    if (!native && !authorize) return null;
    if (!this.enabled) {
      // the generic Composio authorize handles the slug when native is off
      return authorize ? null : { status: 404, body: { error: "native WhatsApp is turned off" } };
    }
    if (method === "GET" && path === "/api/whatsapp/native") {
      return { status: 200, body: { native: true, whatsapp: this.native.snapshot() } };
    }
    if (method === "POST" && (path === "/api/whatsapp/native/connect" || authorize)) {
      return { status: 200, body: { native: true, whatsapp: await this.native.connect() } };
    }
    if (method === "POST" && path === "/api/whatsapp/native/reconnect") {
      return { status: 200, body: { native: true, whatsapp: await this.native.reconnect() } };
    }
    return { status: 405, body: { error: "method not allowed" } };
  }

  /** Read-only routes for the connector bridge, under /api/internal/connectors/.
   * The caller has already authenticated the connector capability and checked
   * the bot's Connected-apps grant. */
  handleInternal(method: string, path: string, params: URLSearchParams): HttpAnswer | null {
    if (!path.startsWith("/api/internal/connectors/whatsapp/")) return null;
    if (!this.enabled) return { status: 404, body: { error: "native WhatsApp is turned off" } };
    if (method !== "GET") return { status: 405, body: { error: "WhatsApp access is read-only" } };
    const snapshot = this.native.snapshot();
    const status = { state: snapshot.state, reason: snapshot.reason, messageCount: snapshot.messageCount };
    if (path === "/api/internal/connectors/whatsapp/chats") {
      return { status: 200, body: { status, chats: this.store.listChats(intParam(params.get("limit"))) } };
    }
    if (path === "/api/internal/connectors/whatsapp/messages") {
      const messages = this.store.listMessages({
        chatId: params.get("chat_id") ?? params.get("chatId") ?? undefined,
        before: intParam(params.get("before")),
        query: params.get("query") ?? undefined,
        limit: intParam(params.get("limit")),
      });
      return { status: 200, body: { status, messages } };
    }
    return { status: 404, body: { error: "no such WhatsApp read route" } };
  }
}
// branding compatibility (electron/branding-compat.json): environment-aliases: legacy launchd/systemd and provider subprocess environment labels stay accepted; the central resolver always prefers the new spelling
