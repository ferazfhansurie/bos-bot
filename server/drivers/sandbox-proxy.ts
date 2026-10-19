// Sandbox MCP proxy — spawned as an MCP server inside a bot's agent process.
// Gives the bot its own BoxCompute Linux VM (boxcompute.ai, hosted in
// Malaysia). The BoxCompute key never reaches this process: every call is
// relayed to the harness with a turn-scoped capability, and the harness
// talks to BoxCompute (server/boxcompute.ts).
//
// Speaks raw JSON-RPC 2.0 over stdio (house style). stdout is the MCP
// transport — never log there. Env:
//   OMB_HARNESS_URL    harness base URL
//   OMB_SANDBOX_TOKEN  turn-scoped "sandbox" internal capability
//   OMB_SANDBOX_DESKTOP "1" when the turn's place is BoxCompute: also list
//                      the cloud desktop tools (the capability decides)
import readline from "node:readline";
import { compatEnv } from "../../electron/branding-env.cjs";

const HARNESS = (compatEnv.OMB_HARNESS_URL ?? "http://127.0.0.1:8799").replace(/\/+$/, "");
const TOKEN = compatEnv.OMB_SANDBOX_TOKEN ?? "";
const DESKTOP = compatEnv.OMB_SANDBOX_DESKTOP === "1";

const TOOLS = [
  {
    name: "sandbox_exec",
    description:
      "Run a bash command in your own cloud Linux sandbox (BoxCompute VM, hosted in Malaysia) and get stdout, stderr and the exit code. /workspace persists between calls; the first call creates the sandbox, which can take a minute. Use it to run code, install packages, clone repos, build and test projects, or host a dev server without touching the person's computer. For a long-running server or watcher, pass background: true (it returns the pid and a log path in a few seconds and keeps running), then call sandbox_preview. Without it, anything left running holds the call open until the timeout.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command, run with bash -lc." },
        cwd: { type: "string", description: "Working directory under /workspace (default /workspace)." },
        timeout_seconds: { type: "number", description: "1-900, default 120." },
        background: { type: "boolean", description: "Start the command detached and return right away (servers, watchers)." },
      },
      required: ["command"],
    },
  },
  {
    name: "sandbox_write_file",
    description: "Write a UTF-8 text file in your sandbox (path under /workspace; parent folders are created). Overwrites.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
  {
    name: "sandbox_read_file",
    description: "Read a text file from your sandbox (path under /workspace), 256 KB at a time.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, offset: { type: "number", description: "Byte offset for the next chunk." } },
      required: ["path"],
    },
  },
  {
    name: "sandbox_list_files",
    description: "List a directory in your sandbox (default /workspace).",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
  },
  {
    name: "sandbox_preview",
    description:
      "Get a public https link (valid one hour) to a web server listening on a port in your sandbox, so the person can open what you built. Anyone holding the link can open it: give it only to the person you are working for.",
    inputSchema: { type: "object", properties: { port: { type: "number" } }, required: ["port"] },
  },
  {
    name: "sandbox_status",
    description: "Show whether you have a sandbox and its state (running, cold, pending, expired). Does not create one.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "sandbox_reset",
    description: "Delete your sandbox and everything in /workspace. Only when the person asks, or when it has expired.",
    inputSchema: { type: "object", properties: {} },
  },
];

const point = {
  x: { type: "number", description: "Pixels from the left of the 1280x800 screenshot." },
  y: { type: "number", description: "Pixels from the top of the 1280x800 screenshot." },
};

const DESKTOP_TOOLS = [
  {
    name: "sandbox_desktop_screenshot",
    description:
      "See the cloud desktop in your sandbox (1280x800, Google Chrome open). Returns the screen as an image; click coordinates are pixels in it. The first desktop call sets the desktop up, which takes about a minute and a half. Take one before acting and after each action that changes the page.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "sandbox_desktop_click",
    description: "Click on the cloud desktop at a point from the latest screenshot.",
    inputSchema: {
      type: "object",
      properties: {
        ...point,
        button: { type: "string", enum: ["left", "right", "middle"], description: "Default left." },
        double: { type: "boolean", description: "Double-click." },
      },
      required: ["x", "y"],
    },
  },
  {
    name: "sandbox_desktop_type",
    description:
      "Type text into whatever has focus on the cloud desktop (click the field first). Passwords and one-time codes are fine when the person gave them to you for that site. Never type card details: send the person sandbox_desktop_live_link and let them enter those.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
  {
    name: "sandbox_desktop_key",
    description: 'Press keys on the cloud desktop: xdotool names separated by spaces, e.g. "Return", "ctrl+l", "ctrl+t", "Tab Tab", "Escape", "alt+Left".',
    inputSchema: { type: "object", properties: { keys: { type: "string" } }, required: ["keys"] },
  },
  {
    name: "sandbox_desktop_scroll",
    description: "Scroll the cloud desktop with the mouse wheel at a point (default the center).",
    inputSchema: {
      type: "object",
      properties: {
        ...point,
        direction: { type: "string", enum: ["up", "down", "left", "right"], description: "Default down." },
        amount: { type: "number", description: "Wheel clicks, 1-30, default 5." },
      },
    },
  },
  {
    name: "sandbox_desktop_open_url",
    description:
      "Open an http(s) address in a new tab of the desktop's Chrome. The same Chrome listens for CDP at http://localhost:9222 inside the sandbox, so heavy scraping can run from sandbox_exec (Playwright chromium.connectOverCDP) in the same signed-in profile.",
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
  {
    name: "sandbox_desktop_live_link",
    description:
      "Get a link (valid one hour) where the person can watch the cloud desktop live and take over the mouse and keyboard, e.g. to sign in to Instagram or LinkedIn themselves. Share it whenever a site needs a sign-in, code, captcha or payment, or when they want to watch. Anyone holding the link controls the desktop: give it only to the person you are working for. One public link per sandbox: this closes an open sandbox_preview link.",
    inputSchema: { type: "object", properties: {} },
  },
];

const LISTED = DESKTOP ? [...TOOLS, ...DESKTOP_TOOLS] : TOOLS;

type Json = Record<string, unknown>;
const send = (msg: Json) => process.stdout.write(JSON.stringify(msg) + "\n");
const ok = (id: unknown, result: unknown) => send({ jsonrpc: "2.0", id, result });
const rpcErr = (id: unknown, code: number, message: string) => send({ jsonrpc: "2.0", id, error: { code, message } });
const textResult = (id: unknown, text: string, isError = false, image?: { data: string; mimeType: string }) =>
  ok(id, { content: [...(image ? [{ type: "image", data: image.data, mimeType: image.mimeType }] : []), { type: "text", text }], isError });

type Image = { data: string; mimeType: string };
const isImage = (value: unknown): value is Image =>
  typeof value === "object" && value !== null && typeof (value as Json).data === "string" && typeof (value as Json).mimeType === "string";

async function callTool(name: string, args: Json): Promise<{ text: string; isError?: boolean; image?: Image }> {
  const res = await fetch(`${HARNESS}/api/internal/sandbox/${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(args),
    // exec can run 900s plus a cold start
    signal: AbortSignal.timeout(16 * 60_000),
  });
  const body = (await res.json().catch(() => ({}))) as Json;
  if (!res.ok) return { text: String(body.error ?? `HTTP ${res.status}`), isError: true };
  return { text: String(body.text ?? ""), ...(isImage(body.image) ? { image: body.image } : {}) };
}

async function handle(msg: Json) {
  const id = msg.id;
  const method = msg.method as string | undefined;
  if (!method) return;
  const params = (msg.params ?? {}) as Json;
  switch (method) {
    case "initialize":
      ok(id, {
        protocolVersion: (params.protocolVersion as string) ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "sandbox-proxy", version: "0.1.0" },
      });
      return;
    case "notifications/initialized":
    case "notifications/cancelled":
      return;
    case "ping":
      ok(id, {});
      return;
    case "tools/list":
      ok(id, { tools: LISTED });
      return;
    case "tools/call": {
      const name = params.name as string;
      if (!LISTED.some((t) => t.name === name)) return rpcErr(id, -32602, `Unknown tool: ${name}`);
      try {
        const rawArgs = params.arguments;
        const args = typeof rawArgs === "object" && rawArgs !== null && !Array.isArray(rawArgs) ? (rawArgs as Json) : {};
        const { text, isError, image } = await callTool(name, args);
        textResult(id, text, isError, image);
      } catch (e) {
        textResult(id, `sandbox request failed: ${e instanceof Error ? e.message : String(e)}`, true);
      }
      return;
    }
    default:
      if (id !== undefined) rpcErr(id, -32601, `Method not found: ${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const t = line.trim();
  if (!t) return;
  let msg: Json;
  try {
    msg = JSON.parse(t) as Json;
  } catch {
    return;
  }
  void handle(msg).catch((e) => {
    if (msg.id !== undefined) rpcErr(msg.id, -32603, (e as Error).message);
  });
});
rl.on("close", () => process.exit(0));
