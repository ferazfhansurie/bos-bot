import { createServer, type RequestListener, type Server } from "node:http";
import { once } from "node:events";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import { afterEach, describe, expect, it } from "vitest";

const ENTRY = join(dirname(fileURLToPath(import.meta.url)), "connector-proxy.ts");
let child: ChildProcessWithoutNullStreams | null = null;
let server: Server | null = null;

async function listen(handler: RequestListener) {
  server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  return `http://127.0.0.1:${address.port}`;
}

function start(env: Record<string, string>) {
  // Fixture values must override every branding alias, never inherit the
  // actual mounted connector URL or capabilities from this agent session.
  const isolated = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(OMB_|OPENMAUSBOT_|BOSBOT_|BOS_)/.test(key)));
  child = spawn(process.execPath, ["--experimental-strip-types", ENTRY], {
    env: { ...isolated, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  return readline.createInterface({ input: child.stdout });
}

function nextJson(lines: readline.Interface) {
  return new Promise<Record<string, any>>((resolve, reject) => {
    lines.once("line", (line) => {
      try { resolve(JSON.parse(line)); } catch (error) { reject(error); }
    });
  });
}

afterEach(async () => {
  child?.kill("SIGKILL");
  child = null;
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

describe("connector MCP bridge", () => {
  it("mounts autonomous reply schemas only with the scoped flag and carries exact reply input over POST", async () => {
    let received: any;
    const harness = await listen((request, response) => {
      let body = "";
      request.on("data", chunk => { body += chunk; });
      request.on("end", () => { received = { method: request.method, url: request.url, body: JSON.parse(body), authorization: request.headers.authorization }; response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ state: "submitted", messageId: "fixture-outbound" })); });
    });
    const lines = start({ OMB_HARNESS_URL: harness, OMB_CONNECTOR_TOKEN: "fixture-token", OMB_WHATSAPP_NATIVE: "1", OMB_WHATSAPP_REPLIES: "1" });
    child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
    const list = await nextJson(lines);
    const tool = list.result.tools.find((t: any) => t.name === "BOS_WHATSAPP_REPLY");
    expect(tool.inputSchema.required).toEqual(["account_id", "chat_id", "message_id", "text"]);
    const input = { account_id: "60111111111@c.us", chat_id: "60222222222@c.us", message_id: "fixture-inbound", text: "hello" };
    child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool.name, arguments: input } })}\n`);
    const result = await nextJson(lines);
    expect(result.result.content[0].text).toContain("submitted");
    expect(received).toEqual({ method: "POST", url: "/api/internal/connectors/whatsapp/reply", authorization: "Bearer fixture-token", body: input });
  });
  it("turns agent connection requests into authenticated chat-card requests", async () => {
    let received: any = null;
    const harness = await listen((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        received = { authorization: request.headers.authorization, body: JSON.parse(body) };
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      });
    });
    const lines = start({
      OMB_HARNESS_URL: harness,
      OMB_CONNECTOR_TOKEN: "bridge-secret",
      // A simultaneously mounted agents proxy may define this different
      // value in Codex's flattened child environment.
      OMB_COMMS_TOKEN: "agents-secret",
      OMB_BOT_ID: "bot-1",
      OMB_THREAD_ID: "thread-1",
    });
    child!.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "COMPOSIO_MANAGE_CONNECTIONS", arguments: { toolkits: ["GMAIL"] } },
    })}\n`);
    const reply = await nextJson(lines);
    expect(reply.id).toBe(7);
    expect(reply.result.content[0].text).toMatch(/secure connection card/i);
    expect(received.authorization).toBe("Bearer bridge-secret");
    expect(received.body).toMatchObject({ botId: "bot-1", threadId: "thread-1", items: [{ slug: "gmail" }] });
    expect(received.body.resumeKey).toMatch(/^[\w-]{8,100}$/);
  });

  it("carries an account alias when the agent asks for a second account", async () => {
    let received: any = null;
    const harness = await listen((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        received = { authorization: request.headers.authorization, body: JSON.parse(body) };
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      });
    });
    const lines = start({
      OMB_HARNESS_URL: harness,
      OMB_CONNECTOR_TOKEN: "bridge-secret",
      OMB_BOT_ID: "bot-1",
      OMB_THREAD_ID: "thread-1",
    });
    child!.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: {
        name: "COMPOSIO_MANAGE_CONNECTIONS",
        arguments: {
          toolkits: [
            { toolkit: "googledrive", alias: "work-devhouse" },
            { name: "LINEAR", account: "personal" },
            { toolkit: "googledrive", alias: "personal" },
            { toolkit: "GOOGLEDRIVE", alias: " Work-Devhouse " },
          ],
        },
      },
    })}\n`);
    const reply = await nextJson(lines);
    expect(reply.id).toBe(8);
    expect(reply.result.content[0].text).toMatch(/secure connection card for googledrive \(work-devhouse\), linear \(personal\)/i);
    expect(received.authorization).toBe("Bearer bridge-secret");
    expect(received.body).toMatchObject({
      botId: "bot-1",
      threadId: "thread-1",
      items: [
        { slug: "googledrive", alias: "work-devhouse" },
        { slug: "linear", alias: "personal" },
        { slug: "googledrive", alias: "personal" },
      ],
    });
  });

  it("answers initialize locally so a missing or failing upstream cannot fail the MCP handshake", async () => {
    const lines = start({});
    child!.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05" },
    })}\n`);
    const reply = await nextJson(lines);
    expect(reply).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "bosbot-connectors", version: "1" },
      },
    });
    expect(reply.result).not.toHaveProperty("isError");
    expect(reply.result).not.toHaveProperty("content");
  });

  it("answers initialize after a bounded wait when the upstream stalls", async () => {
    let sawInitialize!: () => void;
    const received = new Promise<void>((resolve) => { sawInitialize = resolve; });
    const upstream = await listen((request) => {
      request.resume();
      request.on("end", sawInitialize);
      // Deliberately never respond. The proxy must abort this request and
      // return its local capability result instead of hanging OpenCode.
    });
    const lines = start({ OMB_CONNECTOR_UPSTREAM_URL: upstream });
    child!.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 11,
      method: "initialize",
      params: { protocolVersion: "2024-11-05" },
    })}\n`);

    await received;
    const reply = await nextJson(lines);
    expect(reply).toMatchObject({
      id: 11,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
      },
    });
  });

  it("still opens the upstream MCP session on initialize without echoing secrets", async () => {
    let upstreamAuthorization = "";
    let upstreamBody: any = null;
    const methods: string[] = [];
    const sessionHeaders: string[] = [];
    let sawInitialized!: () => void;
    const initialized = new Promise<void>((resolve) => { sawInitialized = resolve; });
    const upstream = await listen((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        upstreamAuthorization = String(request.headers.authorization ?? "");
        upstreamBody = JSON.parse(body);
        methods.push(String(upstreamBody.method ?? ""));
        sessionHeaders.push(String(request.headers["mcp-session-id"] ?? ""));
        response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "transport-1" });
        response.end(upstreamBody.id === undefined
          ? ""
          : JSON.stringify({ jsonrpc: "2.0", id: 2, result: { protocolVersion: "2025-06-18" } }));
        if (upstreamBody.method === "notifications/initialized") sawInitialized();
      });
    });
    const lines = start({
      OMB_CONNECTOR_UPSTREAM_URL: upstream,
      OMB_CONNECTOR_UPSTREAM_HEADERS: JSON.stringify({ authorization: "Bearer upstream-secret" }),
    });
    child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2024-11-05" } })}\n`);
    const reply = await nextJson(lines);
    expect(reply.result.protocolVersion).toBe("2024-11-05");
    expect(reply.result.serverInfo).toEqual({ name: "bosbot-connectors", version: "1" });
    expect(upstreamAuthorization).toBe("Bearer upstream-secret");
    expect(upstreamBody).toMatchObject({ method: "initialize" });
    expect(JSON.stringify(reply)).not.toContain("upstream-secret");

    child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
    await initialized;
    expect(methods).toEqual(["initialize", "notifications/initialized"]);
    expect(sessionHeaders).toEqual(["", "transport-1"]);
  });

  it("relays tools/list without exposing upstream headers on stdout", async () => {
    let upstreamAuthorization = "";
    const upstream = await listen((request, response) => {
      upstreamAuthorization = String(request.headers.authorization ?? "");
      response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "transport-1" });
      response.end(JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        result: { tools: [{ name: "COMPOSIO_SEARCH_TOOLS" }] },
      }));
    });
    const lines = start({
      OMB_CONNECTOR_UPSTREAM_URL: upstream,
      OMB_CONNECTOR_UPSTREAM_HEADERS: JSON.stringify({ authorization: "Bearer upstream-secret" }),
    });
    child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list", params: {} })}\n`);
    const reply = await nextJson(lines);
    expect(reply).toEqual({
      jsonrpc: "2.0",
      id: 4,
      result: { tools: [{ name: "COMPOSIO_SEARCH_TOOLS" }] },
    });
    expect(upstreamAuthorization).toBe("Bearer upstream-secret");
    expect(JSON.stringify(reply)).not.toContain("upstream-secret");
  });

  it("returns a JSON-RPC error, not a tools result, when a non-call relay fails", async () => {
    const lines = start({});
    child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "prompts/list", params: {} })}\n`);
    const reply = await nextJson(lines);
    expect(reply).toEqual({
      jsonrpc: "2.0",
      id: 3,
      error: { code: -32000, message: "connected apps are unavailable" },
    });
  });

  it("marks MANAGE_CONNECTIONS safe and refuses removals from chat", async () => {
    const upstream = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: 6, result: { tools: [
        { name: "COMPOSIO_MANAGE_CONNECTIONS", annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true } },
        { name: "COMPOSIO_MULTI_EXECUTE_TOOL", annotations: { destructiveHint: true } },
      ] } }));
    });
    const lines = start({ OMB_CONNECTOR_UPSTREAM_URL: upstream });
    child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 6, method: "tools/list", params: {} })}\n`);
    const listed = (await nextJson(lines)) as { result: { tools: Array<{ name: string; annotations: Record<string, boolean> }> } };
    expect(listed.result.tools[0].annotations).toEqual({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
    expect(listed.result.tools[1].annotations).toEqual({ destructiveHint: true });
    child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "COMPOSIO_MANAGE_CONNECTIONS", arguments: { toolkits: [{ name: "gmail", action: "remove", account_id: "ca_1" }] } } })}\n`);
    const refused = (await nextJson(lines)) as { result: { isError?: boolean; content: Array<{ text: string }> } };
    expect(refused.result.isError).toBe(true);
    expect(refused.result.content[0].text).toContain("Connected apps");
  });

  it("answers tools/list with no tools when the relay fails, so a required mount still starts", async () => {
    const lines = start({});
    child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/list", params: {} })}\n`);
    expect(await nextJson(lines)).toEqual({ jsonrpc: "2.0", id: 5, result: { tools: [] } });
  });

  it("native WhatsApp: lists two read-only tools with no Composio upstream and reads them over GET", async () => {
    const requests: Array<{ method?: string; url?: string; authorization?: string }> = [];
    const harness = await listen((request, response) => {
      requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: { state: "linked" }, messages: [{ id: "m1", body: "hi", fromMe: true }] }));
    });
    const lines = start({
      OMB_HARNESS_URL: harness,
      OMB_CONNECTOR_TOKEN: "bridge-secret",
      OMB_BOT_ID: "bot-1",
      OMB_THREAD_ID: "thread-1",
      OMB_WHATSAPP_NATIVE: "1",
      OMB_CONNECTOR_UPSTREAM_URL: "",
    });
    child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
    const list = await nextJson(lines);
    const names = list.result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toEqual(["BOS_WHATSAPP_LIST_CHATS", "BOS_WHATSAPP_LIST_MESSAGES", "BOS_WHATSAPP_GET_ACCOUNT", "BOS_WHATSAPP_SYNC_HISTORY"]);
    for (const tool of list.result.tools) expect(tool.annotations?.readOnlyHint).toBe(true);
    expect(names.some((name: string) => /send|reply|seen|mark/i.test(name))).toBe(false);

    child!.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "BOS_WHATSAPP_LIST_MESSAGES", arguments: { chat_id: "123@c.us", limit: 5 } },
    })}\n`);
    const reply = await nextJson(lines);
    expect(reply.id).toBe(2);
    expect(reply.result.content[0].text).toContain("m1");
    expect(requests).toEqual([{
      method: "GET",
      url: "/api/internal/connectors/whatsapp/messages?chat_id=123%40c.us&limit=5",
      authorization: "Bearer bridge-secret",
    }]);
  });

  it("native WhatsApp: a connection request for whatsapp is not turned into a Composio card", async () => {
    let received = false;
    const harness = await listen((_request, response) => {
      received = true;
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    const lines = start({
      OMB_HARNESS_URL: harness,
      OMB_CONNECTOR_TOKEN: "bridge-secret",
      OMB_BOT_ID: "bot-1",
      OMB_THREAD_ID: "thread-1",
      OMB_WHATSAPP_NATIVE: "1",
    });
    child!.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "COMPOSIO_MANAGE_CONNECTIONS", arguments: { toolkits: ["WHATSAPP"] } },
    })}\n`);
    const reply = await nextJson(lines);
    expect(reply.id).toBe(3);
    expect(JSON.stringify(reply)).toMatch(/whatsapp/i);
    expect(received).toBe(false);
  });
});

// 3.0 cards ride OMB_V3_CARDS. Each case runs the bridge with the flag off and
// on against the same fixtures, so "off" is pinned to exactly today's output.
describe("connector MCP bridge: v3 cards", () => {
  const extra: Server[] = [];
  afterEach(async () => {
    await Promise.all(extra.splice(0).map((item) => new Promise<void>((resolve) => item.close(() => resolve()))));
  });
  async function serve(handler: RequestListener) {
    const item = createServer(handler);
    item.listen(0, "127.0.0.1");
    await once(item, "listening");
    extra.push(item);
    const address = item.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    return `http://127.0.0.1:${address.port}`;
  }
  const manageSchema = { type: "object", properties: { toolkits: { type: "array" } }, required: ["toolkits"], additionalProperties: false };
  const upstreamTools = [
    { name: "COMPOSIO_MANAGE_CONNECTIONS", inputSchema: manageSchema, annotations: { destructiveHint: true } },
    { name: "COMPOSIO_MULTI_EXECUTE_TOOL", inputSchema: { type: "object" } },
  ];
  /** Fake Composio relay: answers tools/list, records tools/call bodies and
   * replies to them with the given result. */
  async function fakeUpstream(callResult: unknown = { content: [{ type: "text", text: "ok" }] }) {
    const calls: any[] = [];
    const url = await serve((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const parsed = JSON.parse(body);
        response.writeHead(200, { "content-type": "application/json" });
        if (parsed.method === "tools/list") return response.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: { tools: upstreamTools } }));
        calls.push(parsed);
        response.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: callResult }));
      });
    });
    return { url, calls };
  }
  async function fakeHarness() {
    const cards: any[] = [];
    const url = await serve((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        if (request.url === "/api/internal/connectors/request") cards.push(JSON.parse(body));
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      });
    });
    return { url, cards };
  }
  async function run(v3: boolean, env: Record<string, string>, messages: Record<string, unknown>[]) {
    const lines = start({ OMB_CONNECTOR_TOKEN: "bridge-secret", OMB_BOT_ID: "bot-1", OMB_THREAD_ID: "thread-1", ...env, ...(v3 ? { OMB_V3_CARDS: "1" } : {}) });
    const replies: Record<string, any>[] = [];
    for (const message of messages) {
      child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
      replies.push(await nextJson(lines));
    }
    child!.kill("SIGKILL");
    child = null;
    return replies;
  }

  it("tools/list: off is byte-for-byte today's list, on adds a reason to MANAGE_CONNECTIONS only", async () => {
    const upstream = await fakeUpstream();
    const harness = await fakeHarness();
    const env = { OMB_CONNECTOR_UPSTREAM_URL: upstream.url, OMB_HARNESS_URL: harness.url, OMB_WHATSAPP_NATIVE: "1" };
    const [off] = await run(false, env, [{ id: 1, method: "tools/list" }]);
    const [on] = await run(true, env, [{ id: 1, method: "tools/list" }]);
    const names = (reply: any) => reply.result.tools.map((tool: any) => tool.name);
    expect(names(off)).toEqual(["COMPOSIO_MANAGE_CONNECTIONS", "COMPOSIO_MULTI_EXECUTE_TOOL", "BOS_WHATSAPP_LIST_CHATS", "BOS_WHATSAPP_LIST_MESSAGES", "BOS_WHATSAPP_GET_ACCOUNT", "BOS_WHATSAPP_SYNC_HISTORY"]);
    expect(off.result.tools[0].inputSchema).toEqual(manageSchema);
    expect(names(on)).toEqual(names(off));
    expect(on.result.tools[0].inputSchema.properties.reason).toMatchObject({ type: "string" });
    expect(on.result.tools[0].inputSchema.required).toEqual(["toolkits"]);
    // everything except that one property is identical
    const stripped = structuredClone(on);
    delete stripped.result.tools[0].inputSchema.properties.reason;
    expect(stripped).toEqual(off);
  });

  it("tools/list with only native WhatsApp: off has no connect tool, on lists a local one", async () => {
    const env = { OMB_WHATSAPP_NATIVE: "1" };
    const [off] = await run(false, env, [{ id: 1, method: "tools/list" }]);
    const [on] = await run(true, env, [{ id: 1, method: "tools/list" }]);
    expect(off.result.tools.map((tool: any) => tool.name)).not.toContain("COMPOSIO_MANAGE_CONNECTIONS");
    expect(on.result.tools.map((tool: any) => tool.name)).toEqual(["COMPOSIO_MANAGE_CONNECTIONS", ...off.result.tools.map((tool: any) => tool.name)]);
    expect(on.result.tools[0].annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  });

  it("whatsapp: off is still filtered to the Plugins answer, on becomes a chat card", async () => {
    const call = { id: 2, method: "tools/call", params: { name: "COMPOSIO_MANAGE_CONNECTIONS", arguments: { toolkits: ["WHATSAPP"], reason: "so i can catch you up on chats" } } };
    const offHarness = await fakeHarness();
    const [off] = await run(false, { OMB_HARNESS_URL: offHarness.url, OMB_WHATSAPP_NATIVE: "1" }, [call]);
    expect(off.result.content[0].text).toMatch(/Plugins/);
    expect(offHarness.cards).toEqual([]);

    const onHarness = await fakeHarness();
    const [on] = await run(true, { OMB_HARNESS_URL: onHarness.url, OMB_WHATSAPP_NATIVE: "1" }, [call]);
    expect(on.result.content[0].text).toMatch(/secure connection card for whatsapp/i);
    expect(onHarness.cards).toHaveLength(1);
    expect(onHarness.cards[0]).toMatchObject({ botId: "bot-1", threadId: "thread-1", items: [{ slug: "whatsapp", reason: "so i can catch you up on chats" }] });
  });

  it("reason: carried per toolkit in v3, never sent with the flag off", async () => {
    const call = { id: 3, method: "tools/call", params: { name: "COMPOSIO_MANAGE_CONNECTIONS", arguments: {
      reason: "  so i can draft\n those 4 replies ",
      toolkits: [{ name: "gmail", action: "add" }, { name: "slack", action: "add", reason: "to read #sales" }],
    } } };
    const offHarness = await fakeHarness();
    await run(false, { OMB_HARNESS_URL: offHarness.url }, [call]);
    expect(offHarness.cards[0].items).toEqual([{ slug: "gmail" }, { slug: "slack" }]);
    const onHarness = await fakeHarness();
    await run(true, { OMB_HARNESS_URL: onHarness.url }, [call]);
    expect(onHarness.cards[0].items).toEqual([{ slug: "gmail", reason: "so i can draft those 4 replies" }, { slug: "slack", reason: "to read #sales" }]);
  });

  it("reason is stripped before a non-add MANAGE_CONNECTIONS call reaches Composio", async () => {
    const upstream = await fakeUpstream();
    const harness = await fakeHarness();
    await run(true, { OMB_CONNECTOR_UPSTREAM_URL: upstream.url, OMB_HARNESS_URL: harness.url }, [
      { id: 4, method: "tools/call", params: { name: "COMPOSIO_MANAGE_CONNECTIONS", arguments: { toolkits: [{ name: "gmail", action: "list" }], reason: "x" } } },
    ]);
    expect(upstream.calls[0].params.arguments).toEqual({ toolkits: [{ name: "gmail", action: "list" }] });
  });

  const expired = { content: [{ type: "text", text: JSON.stringify({ successful: true, data: { results: [
    { tool_slug: "GMAIL_FETCH_EMAILS", index: 0, response: { successful: false, data: {}, error: "('invalid_grant: Token has been expired or revoked.', {'error': 'invalid_grant'})" } },
  ] }, error: null }) }] };
  const execute = (id: number) => ({ id, method: "tools/call", params: { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: [{ tool_slug: "GMAIL_FETCH_EMAILS", arguments: {} }] } } });

  it("reconnect: an expired sign-in raises one card per app in v3, nothing with the flag off", async () => {
    const offUpstream = await fakeUpstream(expired);
    const offHarness = await fakeHarness();
    const [off] = await run(false, { OMB_CONNECTOR_UPSTREAM_URL: offUpstream.url, OMB_HARNESS_URL: offHarness.url }, [execute(5)]);
    expect(off.result).toEqual(expired);
    expect(offHarness.cards).toEqual([]);

    const upstream = await fakeUpstream(expired);
    const harness = await fakeHarness();
    const [first, second] = await run(true, { OMB_CONNECTOR_UPSTREAM_URL: upstream.url, OMB_HARNESS_URL: harness.url }, [execute(5), execute(6)]);
    expect(harness.cards).toHaveLength(1);
    expect(harness.cards[0]).toMatchObject({ botId: "bot-1", threadId: "thread-1", items: [{ slug: "gmail", reconnect: true }] });
    expect(harness.cards[0].resumeKey).toMatch(/^[\w-]{8,100}$/);
    expect(first.result.content[0]).toEqual(expired.content[0]);
    expect(first.result.content.at(-1).text).toMatch(/gmail sign-in expired/);
    expect(second.result.content.at(-1).text).toMatch(/gmail sign-in expired/);
  });

  it("reconnect: an ordinary tool error is relayed untouched in v3", async () => {
    const failed = { content: [{ type: "text", text: JSON.stringify({ successful: false, data: {}, error: "429 Client Error: Too Many Requests" }) }], isError: true };
    const upstream = await fakeUpstream(failed);
    const harness = await fakeHarness();
    const [reply] = await run(true, { OMB_CONNECTOR_UPSTREAM_URL: upstream.url, OMB_HARNESS_URL: harness.url }, [execute(7)]);
    expect(reply.result).toEqual(failed);
    expect(harness.cards).toEqual([]);
  });
});
// branding compatibility (electron/branding-compat.json): environment-aliases: legacy launchd/systemd and provider subprocess environment labels stay accepted; the central resolver always prefers the new spelling
