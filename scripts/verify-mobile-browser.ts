// A real agent-browser session and the production BrowserLive transport,
// isolated from all BOS data. Keep running while the simulator is connected.
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { agentBrowserIntegration, closeAgentBrowser, prepareBrowserSessionState } from "../server/browser-engine.ts";
import { BrowserRuntime } from "../server/browser-runtime.ts";
import { BrowserLive } from "../server/browser-live.ts";

const handlePath = process.argv[2];
if (!handlePath) throw new Error("pass the existing disposable ui fixture handle (ui.json)");
const handle = JSON.parse(readFileSync(handlePath, "utf8"));
const taskHome = mkdtempSync("/tmp/bmb-");
const browserSession = `m-${process.pid}`;
const spec = agentBrowserIntegration({
  binaryPath: handle.binary, session: browserSession, persistent: false,
  encryptionKey: randomBytes(32).toString("hex"),
  env: { PATH: process.env.PATH, HOME: taskHome, AGENT_BROWSER_EXECUTABLE_PATH: handle.chrome },
});
Object.assign(spec.env, { HOME: taskHome, AGENT_BROWSER_SOCKET_DIR: join(taskHome, "sockets") });
const runtime = new BrowserRuntime({ closeBrowser: closeAgentBrowser });
const live = new BrowserLive({ runtime });
const page = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<meta name="viewport" content="width=device-width"><title>shared browser fixture</title>
    <body style="background:#eff1f5;font:24px system-ui;padding:42px;color:#162334">
    <div style="font-size:14px;color:#526276">bos browser acceptance</div><h1>one live session</h1>
    <p id="proof">opened by the agent</p><input aria-label="fixture text" placeholder="type here" style="font:24px system-ui;padding:16px;border-radius:12px">
    <button onclick="document.querySelector('#proof').textContent='tapped from the phone'" style="font:24px system-ui;padding:16px">change the page</button>
    <div style="height:1200px;background:linear-gradient(#eff1f5,#a3bcd8);margin-top:36px">scroll fixture</div>`);
});
await new Promise<void>(resolve => page.listen(0, "127.0.0.1", resolve));
const pageURL = `http://127.0.0.1:${(page.address() as {port:number}).port}`;
await prepareBrowserSessionState(spec.command, browserSession, { env: spec.env, persistent: false });
const opened = await runtime.agentRpc(browserSession, spec, "tools/call", { name: "agent_browser_open", arguments: { url: pageURL } });
if ((opened as {isError?:boolean})?.isError) throw new Error("fixture browser did not open: " + JSON.stringify(opened));
const tools = await runtime.agentRpc(browserSession, spec, "tools/list", {});
writeFileSync(join(taskHome, "tools.json"), JSON.stringify(tools, null, 2));
const server = createServer(async (req, res) => {
  const respond = (status: number, data: unknown) => { res.writeHead(status, {"content-type":"application/json"}); res.end(JSON.stringify(data)); };
  if (req.headers.authorization !== "Bearer browser-fixture-token") return respond(401, {error:"fixture bearer required"});
  const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  const match = /^\/api\/bots\/([\w-]+)\/browser\/(live|action)$/.exec(path);
  try {
    if (match && req.method === "GET" && match[2] === "live") {
      return await live.open({ botId: match[1], session: browserSession, owner: "fixture-phone", spec, isCurrent: () => true, res });
    }
    if (match && req.method === "POST" && match[2] === "action") {
      let body = "";
      for await (const chunk of req) { body += chunk; if (body.length > 32_768) throw new Error("fixture request too large"); }
      const action = JSON.parse(body);
      return respond(200, await live.action({ viewerId: action.viewerId, botId: match[1], owner: "fixture-phone", body: action }));
    }
    if (req.method === "POST" && path === "/fixture/agent-change") {
      return respond(200, await runtime.agentRpc(browserSession, spec, "tools/call", {
        name: "agent_browser_eval", arguments: { script: "document.querySelector('#proof').textContent = 'changed by the agent in the same session'" },
      }));
    }
    return respond(404, {error:"no fixture route"});
  } catch (error) {
    if (!res.headersSent) respond(typeof (error as {status?:unknown}).status === "number" ? (error as {status:number}).status : 500, {error: (error as Error).message});
    else res.end();
  }
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
writeFileSync(join(taskHome, "fixture.json"), JSON.stringify({url,pageURL,taskHome,browserSession},null,2));
console.log(JSON.stringify({url,pageURL,taskHome,browserSession}));
let stopped = false;
const close = async () => {
  if (stopped) return; stopped = true;
  live.closeAll(); await runtime.closeAll(); await closeAgentBrowser(browserSession, spec);
  server.closeAllConnections(); page.closeAllConnections(); server.close(); page.close();
};
process.once("SIGINT", () => void close()); process.once("SIGTERM", () => void close());
