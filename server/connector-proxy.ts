// Harness-owned Composio MCP bridge.
//
// Provider CLIs only see this stdio server. Ordinary MCP traffic is relayed
// to the configured Composio Session, but connection requests are converted
// into first-class OpenMausBot chat cards. The agent never authors an auth
// URL and credentials never pass through its transcript.
//
// stdout is the MCP transport. Never log there.
import readline from "node:readline";
import { randomUUID } from "node:crypto";

type Json = Record<string, unknown>;

const UPSTREAM = process.env.OMB_CONNECTOR_UPSTREAM_URL ?? "";
const HARNESS = process.env.OMB_HARNESS_URL ?? "http://127.0.0.1:8799";
const BOT_ID = process.env.OMB_BOT_ID ?? "";
const THREAD_ID = process.env.OMB_THREAD_ID ?? "";
const TOKEN = process.env.OMB_CONNECTOR_TOKEN ?? process.env.OMB_COMMS_TOKEN ?? "";
// Native read-only WhatsApp (server/whatsapp-service.ts). Mounted only for a
// bot whose Connected-apps grant is on; the harness re-checks the grant on
// every call. There is deliberately no write tool of any kind.
const WHATSAPP_NATIVE = process.env.OMB_WHATSAPP_NATIVE === "1";
const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;
const INITIALIZE_RELAY_TIMEOUT_MS = 1_000;
const RELAY_TIMEOUT_MS = 10 * 60_000;

function parsedHeaders(): Record<string, string> {
  try {
    const value: unknown = JSON.parse(process.env.OMB_CONNECTOR_UPSTREAM_HEADERS ?? "{}");
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
      serverInfo: { name: "openmausbot-connectors", version: "1" },
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
] as const;

const WHATSAPP_ROUTES: Record<string, { path: string; params: string[] }> = {
  BOS_WHATSAPP_LIST_CHATS: { path: "chats", params: ["limit"] },
  BOS_WHATSAPP_LIST_MESSAGES: { path: "messages", params: ["chat_id", "before", "query", "limit"] },
};

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
}

function connectorAdds(args: unknown): ConnectorRequest[] {
  if (!args || typeof args !== "object" || Array.isArray(args)) return [];
  const toolkits = (args as { toolkits?: unknown }).toolkits;
  if (!Array.isArray(toolkits)) return [];
  const seen = new Set<string>();
  const requests: ConnectorRequest[] = [];
  for (const item of toolkits) {
    if (typeof item === "string") {
      const slug = item.trim().toLowerCase();
      const key = JSON.stringify([slug, ""]);
      if (!seen.has(key)) {
        seen.add(key);
        requests.push({ slug });
      }
      continue;
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as { name?: unknown; toolkit?: unknown; action?: unknown; alias?: unknown; account?: unknown };
    const action = String(row.action ?? "add").toLowerCase();
    if (!["add", "connect", "initiate"].includes(action)) continue;
    const slug = typeof row.toolkit === "string" ? row.toolkit : row.name;
    if (typeof slug !== "string") continue;
    const normalized = slug.trim().toLowerCase();
    const alias = (typeof row.alias === "string" ? row.alias : typeof row.account === "string" ? row.account : "").trim();
    const key = JSON.stringify([normalized, alias.toLowerCase()]);
    if (seen.has(key)) continue;
    seen.add(key);
    requests.push({ slug: normalized, ...(alias ? { alias } : {}) });
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
  if (method === "tools/list" && WHATSAPP_NATIVE) {
    let upstream: Json | null = null;
    if (UPSTREAM) {
      try {
        upstream = await relay(message);
      } catch {
        // Composio being down must not hide the local read tools.
      }
    }
    if (id === undefined) return;
    const result = (upstream?.result ?? {}) as Json;
    const tools = Array.isArray(result.tools) ? result.tools : [];
    send({ ...(upstream ?? { jsonrpc: "2.0", id }), result: { ...result, tools: [...tools, ...WHATSAPP_TOOLS] } });
    return;
  }
  if (method === "tools/call") {
    const params = (message.params ?? {}) as Json;
    const name = String(params.name ?? "");
    if (WHATSAPP_NATIVE && Object.hasOwn(WHATSAPP_ROUTES, name)) {
      try {
        send(textResult(id, await whatsappRead(name, params.arguments)));
      } catch (error) {
        send(textResult(id, error instanceof Error ? error.message : String(error), true));
      }
      return;
    }
    const allRequests = /MANAGE_CONNECTIONS$/i.test(name) ? connectorAdds(params.arguments) : [];
    // WhatsApp links natively (a QR code in Connected apps), never through a
    // Composio connection card.
    const requests = allRequests.filter((request) => request.slug !== "whatsapp");
    if (allRequests.length && !requests.length) {
      send(textResult(
        id,
        "WhatsApp is linked on this Mac, not through a connection card. Ask the user to open Plugins → Connected apps → WhatsApp and scan the QR code. Access is read-only.",
      ));
      return;
    }
    if (requests.length) {
      await showConnectorCards(requests);
      const labels = requests.map((r) => (r.alias ? `${r.slug} (${r.alias})` : r.slug)).join(", ");
      send(textResult(
        id,
        `OpenMausBot showed the user a secure connection card for ${labels}. End this turn now. The app will continue the task automatically after the connection finishes.`,
      ));
      return;
    }
    if (/WAIT_FOR_CONNECTIONS$/i.test(name)) {
      send(textResult(id, "OpenMausBot is handling connection completion and will continue the task automatically."));
      return;
    }
  }
  try {
    const response = await relay(message);
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
