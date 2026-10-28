import { compatEnv } from "../electron/branding-env.cjs";
// Harness-owned Composio MCP bridge.
//
// Provider CLIs only see this stdio server. Ordinary MCP traffic is relayed
// to the configured Composio Session, but connection requests are converted
// into first-class BOS Bot chat cards. The agent never authors an auth
// URL and credentials never pass through its transcript.
//
// stdout is the MCP transport. Never log there.
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import { expiredConnections } from "./connector-auth.ts";

type Json = Record<string, unknown>;

const UPSTREAM = compatEnv.OMB_CONNECTOR_UPSTREAM_URL ?? "";
const HARNESS = compatEnv.OMB_HARNESS_URL ?? "http://127.0.0.1:8799";
const BOT_ID = compatEnv.OMB_BOT_ID ?? "";
const THREAD_ID = compatEnv.OMB_THREAD_ID ?? "";
const TOKEN = compatEnv.OMB_CONNECTOR_TOKEN ?? compatEnv.OMB_COMMS_TOKEN ?? "";
// Native read-only WhatsApp (server/whatsapp-service.ts). Mounted only for a
// bot whose Connected-apps grant is on; the harness re-checks the grant on
// every call. The reply tool mounts only with a separate owner policy.
const WHATSAPP_NATIVE = compatEnv.OMB_WHATSAPP_NATIVE === "1";
const WHATSAPP_REPLIES = compatEnv.OMB_WHATSAPP_REPLIES === "1";
// 3.0 cards (features.v3, the labs switch): connect asks carry a reason, WhatsApp links
// in the chat through the same card, and an expired sign-in comes back as a
// reconnect card. Off, every answer below is exactly the 2.x one.
const V3_CARDS = compatEnv.OMB_V3_CARDS === "1";
const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;
const INITIALIZE_RELAY_TIMEOUT_MS = 1_000;
const RELAY_TIMEOUT_MS = 10 * 60_000;
// codex mounts this server as required, so tools/list must answer well inside
// its 20s startup window even when the connector service stalls
const LIST_RELAY_TIMEOUT_MS = 12_000;

function parsedHeaders(): Record<string, string> {
  try {
    const value: unknown = JSON.parse(compatEnv.OMB_CONNECTOR_UPSTREAM_HEADERS ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  } catch {
    return {};
  }
}

const upstreamHeaders = parsedHeaders();
let upstreamSessionId = "";
const send = (message: Json) => process.stdout.write(`${JSON.stringify(message)}\n`);

function textResult(id: unknown, text: string, isError = false): Json {
  return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) } };
}

function jsonRpcError(id: unknown, message: string): Json {
  return { jsonrpc: "2.0", id, error: { code: -32000, message } };
}

function initializeResult(id: unknown, protocolVersion: unknown): Json {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      protocolVersion: typeof protocolVersion === "string" && protocolVersion ? protocolVersion : "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "bosbot-connectors", version: "1" },
    },
  };
}

async function readBounded(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_RESPONSE_BYTES) throw new Error("connector response exceeded 20 MB");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("connector response exceeded 20 MB");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function parseUpstream(text: string, id: unknown): Json | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{")) return JSON.parse(trimmed) as Json;
  const frames = trimmed
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((line) => line && line !== "[DONE]")
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Json];
      } catch {
        return [];
      }
    });
  return frames.findLast((frame) => frame.id === id) ?? frames.at(-1) ?? null;
}

async function relay(message: Json, timeoutMs = RELAY_TIMEOUT_MS): Promise<Json | null> {
  if (!UPSTREAM) throw new Error("connected apps are unavailable");
  const response = await fetch(UPSTREAM, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...upstreamHeaders,
      ...(upstreamSessionId ? { "mcp-session-id": upstreamSessionId } : {}),
    },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const nextSession = response.headers.get("mcp-session-id");
  if (nextSession) upstreamSessionId = nextSession;
  if (!response.ok) throw new Error(`connector service returned HTTP ${response.status}`);
  return parseUpstream(await readBounded(response), message.id);
}

const WHATSAPP_TOOLS = [
  {
    name: "BOS_WHATSAPP_LIST_CHATS",
    description:
      "List the user's recent WhatsApp chats captured on this Mac (read-only), newest activity first, with each chat's id, name, message count and latest message.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 200, description: "How many chats (default 30)." } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "BOS_WHATSAPP_LIST_MESSAGES",
    description:
      "Read captured WhatsApp messages (read-only), newest first. Both received messages and ones the user sent are included (fromMe). Filter by chat_id from BOS_WHATSAPP_LIST_CHATS, page with before (unix seconds of the oldest message already seen), or search with query.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "string", description: "Chat id such as 15551234567@c.us or ...@g.us." },
        before: { type: "integer", description: "Only messages older than this unix timestamp (seconds)." },
        query: { type: "string", description: "Case-insensitive text to find in message bodies." },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "How many messages (default 50)." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  { name: "BOS_WHATSAPP_GET_ACCOUNT", description: "Verify the linked WhatsApp account, the owner-configured reply scope and the read scope (all chats or a list).", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
  { name: "BOS_WHATSAPP_SYNC_HISTORY", description: "Request history for an exact chat on the verified linked account and capture up to 200 currently available messages. requested does not prove full history. Does not send a message, mark seen or trigger replies to imported history.", inputSchema: { type: "object", properties: { account_id: { type: "string" }, chat_id: { type: "string" } }, required: ["account_id", "chat_id"], additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true } },
] as const;

const WHATSAPP_ROUTES: Record<string, { path: string; params: string[] }> = {
  BOS_WHATSAPP_LIST_CHATS: { path: "chats", params: ["limit"] },
  BOS_WHATSAPP_LIST_MESSAGES: { path: "messages", params: ["chat_id", "before", "query", "limit"] },
};

const WHATSAPP_REPLY_TOOLS = [
  { name: "BOS_WHATSAPP_REPLY", description: "Reply without additional approval to one captured incoming text from the last 24 hours, only in the owner's configured scope. Verify account and chat first. No outreach. One attempt per incoming message; never retry outcome_unknown. submitted is not recipient delivery.", inputSchema: { type: "object", properties: { account_id: { type: "string" }, chat_id: { type: "string" }, message_id: { type: "string" }, text: { type: "string", minLength: 1, maxLength: 4000 } }, required: ["account_id", "chat_id", "message_id", "text"], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: true } },
  { name: "BOS_WHATSAPP_SEND", description: "Send a message without an incoming message or time window, only when the owner granted outreach and only to a chat in the configured list (follow-ups). Pick a unique send_key per intended message; one attempt per key, never retry outcome_unknown. submitted is not recipient delivery.", inputSchema: { type: "object", properties: { account_id: { type: "string" }, chat_id: { type: "string" }, send_key: { type: "string", pattern: "^[\\w.:-]{1,120}$" }, text: { type: "string", minLength: 1, maxLength: 4000 } }, required: ["account_id", "chat_id", "send_key", "text"], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: true } },
] as const;

async function whatsappReplyTool(name: string, args: unknown): Promise<string> {
  const response = await fetch(`${HARNESS}/api/internal/connectors/whatsapp/${name === "BOS_WHATSAPP_GET_ACCOUNT" ? "account" : name === "BOS_WHATSAPP_SYNC_HISTORY" ? "sync-history" : name === "BOS_WHATSAPP_SEND" ? "send" : "reply"}`, {
    method: name === "BOS_WHATSAPP_GET_ACCOUNT" ? "GET" : "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    ...(name !== "BOS_WHATSAPP_GET_ACCOUNT" ? { body: JSON.stringify(args) } : {}),
    signal: AbortSignal.timeout(45_000),
  });
  const body = await readBounded(response);
  if (!response.ok) throw new Error(`WhatsApp reply tool refused (HTTP ${response.status}): ${body.slice(0, 300)}`);
  return body;
}

async function whatsappRead(name: string, args: unknown): Promise<string> {
  const route = WHATSAPP_ROUTES[name];
  const input = args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : {};
  const query = new URLSearchParams();
  for (const key of route.params) {
    const value = input[key];
    if (typeof value === "string" || typeof value === "number") query.set(key, String(value));
  }
  // GET only: the harness serves these from its local capture store.
  const response = await fetch(`${HARNESS}/api/internal/connectors/whatsapp/${route.path}?${query}`, {
    method: "GET",
    headers: { authorization: `Bearer ${TOKEN}` },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await readBounded(response);
  if (!response.ok) {
    let detail = text.slice(0, 300);
    try {
      detail = String((JSON.parse(text) as { error?: unknown }).error ?? detail);
    } catch {}
    throw new Error(`WhatsApp read failed (HTTP ${response.status}): ${detail}`);
  }
  return text;
}

interface ConnectorRequest {
  slug: string;
  alias?: string;
  /** v3: the bot's one line on why it needs the app ("so i can draft those replies"). */
  reason?: string;
  /** v3: the app was connected but its sign-in expired or was revoked. */
  reconnect?: true;
}

const REASON_SCHEMA = {
  type: "string",
  maxLength: 140,
  description: "One short line, shown to the user on the connect card, saying what you need the app for. Starts lowercase and reads after \"<bot> needs <app>\", e.g. \"so i can draft those 4 replies\".",
};

/** v3 tools/list: MANAGE_CONNECTIONS takes a reason. */
function withReason(tool: Json): Json {
  const schema = tool.inputSchema && typeof tool.inputSchema === "object" && !Array.isArray(tool.inputSchema) ? tool.inputSchema as Json : null;
  if (!schema || (schema.type !== undefined && schema.type !== "object")) return tool;
  const properties = schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties) ? schema.properties as Json : {};
  if (properties.reason !== undefined) return tool;
  return { ...tool, inputSchema: { ...schema, properties: { ...properties, reason: REASON_SCHEMA } } };
}

/** v3, when Composio lists no MANAGE_CONNECTIONS (only native WhatsApp is
 * mounted, or the service is down): the bridge answers connect asks itself,
 * so a bot can still put a connect card (WhatsApp's QR) in the chat. */
const LOCAL_MANAGE_CONNECTIONS = {
  name: "COMPOSIO_MANAGE_CONNECTIONS",
  description: "Ask the user to connect an app without leaving the chat. BOS Bot shows a secure connect card (WhatsApp shows its QR code in the card) and continues your task once it is connected. Only action \"add\" is available here.",
  inputSchema: {
    type: "object",
    properties: {
      toolkits: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "Toolkit slug, e.g. whatsapp or gmail." },
            action: { type: "string", enum: ["add"] },
          },
          required: ["name"],
        },
      },
      reason: REASON_SCHEMA,
    },
    required: ["toolkits"],
  },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
} as const;

function reasonOf(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const line = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 140);
  return line || undefined;
}

function connectorRemoves(args: unknown): boolean {
  const toolkits = args && typeof args === "object" && !Array.isArray(args) ? (args as { toolkits?: unknown }).toolkits : undefined;
  return Array.isArray(toolkits) && toolkits.some((item) =>
    item && typeof item === "object" && !Array.isArray(item)
    && ["remove", "delete", "disconnect"].includes(String((item as { action?: unknown }).action ?? "").toLowerCase()));
}

function connectorAdds(args: unknown): ConnectorRequest[] {
  if (!args || typeof args !== "object" || Array.isArray(args)) return [];
  const toolkits = (args as { toolkits?: unknown }).toolkits;
  if (!Array.isArray(toolkits)) return [];
  const sharedReason = V3_CARDS ? reasonOf((args as { reason?: unknown }).reason) : undefined;
  const seen = new Set<string>();
  const requests: ConnectorRequest[] = [];
  for (const item of toolkits) {
    if (typeof item === "string") {
      const slug = item.trim().toLowerCase();
      const key = JSON.stringify([slug, ""]);
      if (!seen.has(key)) {
        seen.add(key);
        requests.push({ slug, ...(sharedReason ? { reason: sharedReason } : {}) });
      }
      continue;
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as { name?: unknown; toolkit?: unknown; action?: unknown; alias?: unknown; account?: unknown; reason?: unknown };
    const action = String(row.action ?? "add").toLowerCase();
    if (!["add", "connect", "initiate"].includes(action)) continue;
    const slug = typeof row.toolkit === "string" ? row.toolkit : row.name;
    if (typeof slug !== "string") continue;
    const normalized = slug.trim().toLowerCase();
    const alias = (typeof row.alias === "string" ? row.alias : typeof row.account === "string" ? row.account : "").trim();
    const key = JSON.stringify([normalized, alias.toLowerCase()]);
    if (seen.has(key)) continue;
    seen.add(key);
    const reason = V3_CARDS ? reasonOf(row.reason) ?? sharedReason : undefined;
    requests.push({ slug: normalized, ...(alias ? { alias } : {}), ...(reason ? { reason } : {}) });
  }
  return requests;
}

async function showConnectorCards(items: ConnectorRequest[]): Promise<void> {
  const response = await fetch(`${HARNESS}/api/internal/connectors/request`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ botId: BOT_ID, threadId: THREAD_ID, items, resumeKey: randomUUID() }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: unknown };
    throw new Error(String(body.error ?? `could not show connection card (HTTP ${response.status})`));
  }
}

// One reconnect card per app for the life of this bridge (one turn); the
// harness also refuses a second open reconnect card for the same thread.
const reconnectShown = new Set<string>();

/** v3: a tool result that says the sign-in expired raises a reconnect card,
 * and the bot is told so instead of having to explain an auth error. */
async function noteExpiredSignIns(message: Json, response: Json): Promise<void> {
  const params = (message.params ?? {}) as Json;
  const result = response.result as Json | undefined;
  if (!result || !Array.isArray(result.content)) return;
  const expired = expiredConnections(String(params.name ?? ""), params.arguments, result);
  if (!expired.length) return;
  const fresh = expired.filter((slug) => !reconnectShown.has(slug));
  if (fresh.length) {
    try {
      await showConnectorCards(fresh.map((slug) => ({ slug, reconnect: true as const })));
      for (const slug of fresh) reconnectShown.add(slug);
    } catch {
      // the original result still reaches the bot unchanged
    }
  }
  const shown = expired.filter((slug) => reconnectShown.has(slug));
  if (!shown.length) return;
  result.content = [
    ...result.content,
    {
      type: "text",
      text: `BOS Bot: the ${shown.join(", ")} sign-in expired, so the user now sees a card in the chat to sign in again. Tell them in one short line, then end this turn. The task continues automatically once they reconnect; do not ask them to connect it again.`,
    },
  ];
}

async function handle(message: Json): Promise<void> {
  const id = message.id;
  const method = String(message.method ?? "");
  // OpenCode (and other MCP clients) mark a stdio server failed unless
  // initialize returns capabilities/serverInfo. Relaying that handshake to
  // Composio can time out, return a newer protocolVersion, or throw when the
  // upstream URL never reached the child env — all of which previously
  // surfaced as a tools/call-shaped {content,isError} payload.
  if (method === "notifications/initialized" || method === "initialized") {
    if (UPSTREAM) void relay(message).catch(() => {});
    return;
  }
  if (method === "initialize") {
    if (UPSTREAM) {
      try {
        // Capture the upstream session id when the service is healthy, but
        // never let a stalled provider prevent the local MCP client from
        // mounting the connector tools. The client sends initialized only
        // after this bounded attempt and the local initialize response.
        await relay(message, INITIALIZE_RELAY_TIMEOUT_MS);
      } catch {
        // Best-effort session setup. The client still needs a valid result.
      }
    }
    if (id !== undefined) {
      const params = (message.params ?? {}) as Json;
      send(initializeResult(id, params.protocolVersion));
    }
    return;
  }
  if (method === "ping" && !UPSTREAM) {
    if (id !== undefined) send({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  if (method === "tools/list") {
    let upstream: Json | null = null;
    if (UPSTREAM) {
      try {
        upstream = await relay(message, LIST_RELAY_TIMEOUT_MS);
      } catch {
        // Composio being down must not hide the local read tools, nor fail
        // the required mount and with it the whole turn.
      }
    }
    if (id === undefined) return;
    const result = (upstream?.result ?? {}) as Json;
    // Composio marks MANAGE_CONNECTIONS destructive, so codex asked "allow?"
    // before every connect. Here an add only shows a card and remove is
    // refused below, so it carries no side effect worth a prompt.
    const tools = (Array.isArray(result.tools) ? result.tools : []).map((tool) =>
      tool && typeof tool === "object" && /MANAGE_CONNECTIONS$/i.test(String((tool as Json).name ?? ""))
        ? { ...(tool as Json), annotations: { ...((tool as Json).annotations as Json | undefined), readOnlyHint: true, destructiveHint: false, openWorldHint: false } }
        : tool);
    const local: Json[] = WHATSAPP_NATIVE ? [...WHATSAPP_TOOLS, ...(WHATSAPP_REPLIES ? WHATSAPP_REPLY_TOOLS : [])] : [];
    if (V3_CARDS) {
      const manage = (tool: unknown) => !!tool && typeof tool === "object" && /MANAGE_CONNECTIONS$/i.test(String((tool as Json).name ?? ""));
      const v3Tools = tools.map((tool) => (manage(tool) ? withReason(tool as Json) : tool));
      if (!v3Tools.some(manage)) local.unshift(LOCAL_MANAGE_CONNECTIONS);
      send({ jsonrpc: "2.0", id, result: { ...result, tools: [...v3Tools, ...local] } });
      return;
    }
    send({ jsonrpc: "2.0", id, result: { ...result, tools: [...tools, ...local] } });
    return;
  }
  if (method === "tools/call") {
    const params = (message.params ?? {}) as Json;
    const name = String(params.name ?? "");
    if (name === "BOS_WHATSAPP_GET_ACCOUNT" || name === "BOS_WHATSAPP_SYNC_HISTORY" || name === "BOS_WHATSAPP_REPLY" || name === "BOS_WHATSAPP_SEND") {
      if (!WHATSAPP_NATIVE || ((name === "BOS_WHATSAPP_REPLY" || name === "BOS_WHATSAPP_SEND") && !WHATSAPP_REPLIES)) { send(textResult(id, "WhatsApp replies are not enabled for this bot", true)); return; }
      try { send(textResult(id, await whatsappReplyTool(name, params.arguments))); }
      catch (error) { send(textResult(id, error instanceof Error ? error.message : String(error), true)); }
      return;
    }
    if (WHATSAPP_NATIVE && Object.hasOwn(WHATSAPP_ROUTES, name)) {
      try {
        send(textResult(id, await whatsappRead(name, params.arguments)));
      } catch (error) {
        send(textResult(id, error instanceof Error ? error.message : String(error), true));
      }
      return;
    }
    if (/MANAGE_CONNECTIONS$/i.test(name) && connectorRemoves(params.arguments)) {
      send(textResult(
        id,
        "Removing a connected account is done by the user: ask them to open Plugins → Connected apps and disconnect it there.",
        true,
      ));
      return;
    }
    const allRequests = /MANAGE_CONNECTIONS$/i.test(name) ? connectorAdds(params.arguments) : [];
    // WhatsApp links natively, never through a Composio connection card. In
    // 2.x that QR lives in Connected apps; in v3 the chat card draws it.
    const requests = V3_CARDS ? allRequests : allRequests.filter((request) => request.slug !== "whatsapp");
    if (allRequests.length && !requests.length) {
      send(textResult(
        id,
        "WhatsApp is linked on this Mac, not through a connection card. Ask the user to open Plugins → Connected apps → WhatsApp and scan the QR code. Reply capability depends on the owner-configured bot policy.",
      ));
      return;
    }
    if (requests.length) {
      await showConnectorCards(requests);
      const labels = requests.map((r) => (r.alias ? `${r.slug} (${r.alias})` : r.slug)).join(", ");
      send(textResult(
        id,
        `BOS Bot showed the user a secure connection card for ${labels}. End this turn now. The app will continue the task automatically after the connection finishes.`,
      ));
      return;
    }
    if (/WAIT_FOR_CONNECTIONS$/i.test(name)) {
      send(textResult(id, "BOS Bot is handling connection completion and will continue the task automatically."));
      return;
    }
    if (V3_CARDS && /MANAGE_CONNECTIONS$/i.test(name) && params.arguments && typeof params.arguments === "object" && "reason" in (params.arguments as Json)) {
      // the reason is ours: Composio's own schema does not know it
      const { reason: _reason, ...rest } = params.arguments as Json;
      message = { ...message, params: { ...params, arguments: rest } };
    }
  }
  try {
    const response = await relay(message);
    if (response && id !== undefined && V3_CARDS && method === "tools/call") await noteExpiredSignIns(message, response);
    if (response && id !== undefined) send(response);
  } catch (error) {
    if (id === undefined) return;
    const messageText = error instanceof Error ? error.message : String(error);
    if (method === "tools/call") send(textResult(id, messageText, true));
    else send(jsonRpcError(id, messageText));
  }
}

const input = readline.createInterface({ input: process.stdin, terminal: false });
input.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message: Json;
  try {
    message = JSON.parse(trimmed) as Json;
  } catch {
    return;
  }
  void handle(message).catch((error) => {
    if (message.id === undefined) return;
    const method = String(message.method ?? "");
    const messageText = error instanceof Error ? error.message : String(error);
    if (method === "tools/call") send(textResult(message.id, messageText, true));
    else send(jsonRpcError(message.id, messageText));
  });
});
input.on("close", () => process.exit(0));
// branding compatibility (electron/branding-compat.json): environment-aliases: legacy launchd/systemd and provider subprocess environment labels stay accepted; the central resolver always prefers the new spelling
