import { compatEnv } from "../electron/branding-env.cjs";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { TerminalService, terminalTransportAllowed } from "./terminal.ts";
import { resolveRequestAuth } from "./request-auth.ts";
import { SessionRegistry } from "./sessions.ts";
import { WorkspaceBackupMaintenance } from "./workspace-backup-maintenance.ts";

let server: Server;
let service: TerminalService;
let url: string;
let cwd: string;
let sessions: SessionRegistry;
let now: number;
let targetValid: boolean;
let maintenance: WorkspaceBackupMaintenance;
const sockets: WebSocket[] = [];
const frames = new Map<WebSocket, any[]>();
const shellPrompt = "terminal-fixture-ready> ";
beforeEach(async () => {
  cwd = mkdtempSync(join(tmpdir(), "bos-terminal-"));
  writeFileSync(join(cwd, "fixture-file"), "fixture");
  // Use a controlled interactive shell rather than the runner's login shell.
  writeFileSync(join(cwd, ".terminal-rc"), "");
  vi.stubEnv("SHELL", "/bin/sh");
  vi.stubEnv("HOME", cwd);
  vi.stubEnv("ENV", join(cwd, ".terminal-rc"));
  vi.stubEnv("PS1", shellPrompt);
  sessions = new SessionRegistry({ file: join(cwd, "sessions.json") });
  now = Date.now(); targetValid = true;
  maintenance = new WorkspaceBackupMaintenance();
  service = new TerminalService({
    ownerToken: () => "fixture-owner-capability",
    authenticate: req => resolveRequestAuth(req, { sessions, cookieName: "fixture", streamPath: "/api/events", url: new URL(req.url!, url), loopbackMutationToken: "fixture-owner-capability" }).auth?.kind === "loopback",
    resolveTarget: (botId, threadId) => {
      if (!targetValid || botId !== "bot" || threadId !== "thread") throw Object.assign(new Error("No such terminal target"), { status: 404 });
      return cwd;
    },
    now: () => now,
    claim: () => maintenance.request(),
  });
  server = createServer(async (req, res) => {
    try {
      if (await service.handle(req, res)) return;
      res.writeHead(404); res.end();
    } catch { res.writeHead(500); res.end(); }
  });
  server.on("upgrade", (req, socket, head) => service.upgrade(req, socket, head));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
});
afterEach(async () => {
  await service.close();
  sockets.splice(0).forEach(s => s.terminate()); frames.clear();
  await new Promise<void>(resolve => server.close(() => resolve()));
  sessions.close(); rmSync(cwd, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
function mint(body: unknown = {botId: "bot", threadId: "thread"}, headers: Record<string, string> = {}) {
  return fetch(`${url}/api/terminal/ticket`, {method: "POST", headers: {"content-type": "application/json", "x-openmausbot-desktop-owner": "fixture-owner-capability", origin: url, ...headers}, body: JSON.stringify(body)});
}
async function ticket() { const r = await mint(); expect(r.status).toBe(201); return ((await r.json()) as {ticket:string}).ticket; }
function connect(t: string, origin = url) {
  const ws = new WebSocket(`${url.replace("http:", "ws:")}/api/terminal?ticket=${t}`, {origin});
  sockets.push(ws); frames.set(ws, []);
  ws.on("message", data => frames.get(ws)?.push(JSON.parse(data.toString())));
  return ws;
}
async function waitFor(ws: WebSocket, predicate: (items: any[]) => boolean, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate(frames.get(ws)!)) {
    if (Date.now() > deadline) {
      const items = frames.get(ws)!;
      // Do not include raw shell output: credential tests use this helper too.
      throw new Error(`terminal fixture timed out (socket ${ws.readyState}, frames ${items.map(f => f.type).join(",")})`);
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return frames.get(ws)!;
}
async function denied(t: string, origin = url) {
  const ws = connect(t, origin);
  const status = await new Promise<number>((resolve, reject) => {
    ws.once("unexpected-response", (_req, res) => {res.resume(); ws.terminate(); resolve(res.statusCode!);});
    ws.once("open", () => reject(new Error("unexpected terminal access")));
    ws.on("error", () => {});
  });
  return status;
}
it("runs a real pty in the server folder, resizes it and emits exit", async () => {
  const ws = connect(await ticket());
  await waitFor(ws, items => items.some(f => f.type === "ready" && f.cwd === cwd));
  ws.send(JSON.stringify({type: "resize", cols: 53, rows: 31}));
  ws.send(JSON.stringify({type: "input", data: "pwd; ls fixture-file; stty size; printf 'verified-marker\\n'\r"}));
  const items = await waitFor(ws, items => items.filter(f => f.type === "output").map(f => f.data).join("").includes("31 53"));
  const output = items.filter(f => f.type === "output").map(f => f.data).join("");
  expect(output).toContain(cwd); expect(output).toContain("fixture-file");
  ws.send(JSON.stringify({type: "input", data: "exit 7\r"}));
  await waitFor(ws, items => items.some(f => f.type === "exit" && f.code === 7));
});
it("strips workspace credentials from the real shell without changing the server env", async () => {
  vi.stubEnv("SHELL", "/bin/sh");
  vi.stubEnv("HOME", cwd);
  for (const key of ["XAI_API_KEY", "BOX_TOKEN", "OMB_TTS_KEY"]) vi.stubEnv(key, "fixture-workspace-secret");
  vi.stubEnv("TERMINAL_FIXTURE_SAFE", "safe-value");
  try {
    const ws = connect(await ticket());
    await waitFor(ws, items => items.some(f => f.type === "ready"));
    ws.send(JSON.stringify({type: "input", data: "printf 'credential-state:%s:%s:%s:%s:%s\\n' \"${XAI_API_KEY+present}\" \"${BOX_TOKEN+present}\" \"${OMB_TTS_KEY+present}\" \"$TERMINAL_FIXTURE_SAFE\" \"$TERM\"; exit\r"}));
    const items = await waitFor(ws, items => items.some(f => f.type === "exit"));
    const lines = items.filter(f => f.type === "output").map(f => f.data).join("").split(/\r?\n/);
    expect(lines).toContain("credential-state::::safe-value:xterm-256color");
    for (const key of ["XAI_API_KEY", "BOX_TOKEN", "OMB_TTS_KEY"]) expect(compatEnv[key]).toBe("fixture-workspace-secret");
  } finally { vi.unstubAllEnvs(); }
});
it("requires desktop authority even for a loopback admin or companion", async () => {
  expect((await mint(undefined, {"x-openmausbot-desktop-owner": ""})).status).toBe(403);
  const admin = sessions.issue({label: "remote admin", scopes: ["admin", "client"]});
  expect((await mint(undefined, {authorization: `Bearer ${admin.token}`})).status).toBe(403);
  const rejected: Record<string,string>[] = [{"x-forwarded-for": "1.2.3.4"}, {"x-openmausbot-companion-owner": "secret"}, {"x-openmausbot-companion-auth":"secret"}, {origin: "https://evil.test"}];
  for (const headers of rejected) expect((await mint(undefined, headers)).status).toBe(403);
});
it("rejects wrong targets and all caller-supplied shell options", async () => {
  expect((await mint({botId: "other", threadId: "thread"})).status).toBe(404);
  expect((await mint({botId: "bot", threadId: "other"})).status).toBe(404);
  for (const key of ["cwd", "shell", "executable"]) expect((await mint({botId: "bot", threadId: "thread", [key]: "/tmp"})).status).toBe(400);
});
it("binds origin, expiry, single use and revalidates the target", async () => {
  expect(await denied(await ticket(), "http://localhost:1234")).toBe(403);
  const expired = await ticket(); now += 30_001; expect(await denied(expired)).toBe(403);
  const changed = await ticket(); targetValid = false; expect(await denied(changed)).toBe(404); targetValid = true;
  const used = await ticket(); const ws = connect(used); await waitFor(ws, items => items.some(f => f.type === "ready"));
  expect(await denied(used)).toBe(403);
  expect(await denied(sessions.issue({label: "session", scopes: ["admin"]}).token)).toBe(403);
});
it.each(["not json", JSON.stringify({type:"resize",cols:501,rows:24}), JSON.stringify({type:"resize",cols:20.5,rows:24}), JSON.stringify({type:"input",data:3}), JSON.stringify({type:"unknown"}), Buffer.from("binary")])("closes invalid frames with a typed error (%s)", async frame => {
  const ws = connect(await ticket()); await waitFor(ws, items => items.some(f => f.type === "ready"));
  ws.send(frame); await waitFor(ws, items => items.some(f => f.type === "error"));
});
// Leave headroom for both frame waits, child cleanup and scheduler load.
it.each(["socket", "server"])("kills shell-owned background children when the %s closes", async mode => {
  const ws = connect(await ticket());
  // ready confirms PTY allocation; the prompt confirms shell initialization.
  await waitFor(ws, items => items.some(f => f.type === "ready") &&
    items.filter(f => f.type === "output").map(f => f.data).join("").includes(shellPrompt), 8000);
  ws.send(JSON.stringify({type:"input",data:"sleep 120 & printf 'child:%s\\n' $!\r"}));
  const items = await waitFor(ws, items => /child:(\d+)/.test(items.map(f => f.data ?? "").join("")), 8000);
  const pid = Number(/child:(\d+)/.exec(items.map(f => f.data ?? "").join(""))![1]);
  process.kill(pid, 0); if (mode === "socket") ws.close(); else await service.close();
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("terminal child survived socket close");
}, 30_000);
it("caps outstanding tickets and reclaims expired slots", async () => {
  for (let i = 0; i < 64; i++) await ticket();
  expect((await mint()).status).toBe(429);
  now += 30_001; expect((await mint()).status).toBe(201);
});
it("caps simultaneous shells", async () => {
  for (let i = 0; i < 8; i++) {
    const ws = connect(await ticket()); await waitFor(ws, items => items.some(f => f.type === "ready"));
  }
  expect(service.count).toBe(8); expect((await mint()).status).toBe(429);
});
it("closes a slow output consumer before buffering unbounded terminal data", async () => {
  const ws = connect(await ticket()); await waitFor(ws, items => items.some(f => f.type === "ready"));
  const backlog = vi.spyOn(WebSocket.prototype, "bufferedAmount", "get").mockReturnValue(2*1024*1024);
  try {
    ws.send(JSON.stringify({type:"input",data:"echo output-overflow\r"}));
    const items = await waitFor(ws, items => items.some(f => f.type === "error"));
    expect(items.find(f => f.type === "error").error).toMatch(/buffer/);
  } finally {backlog.mockRestore();}
});
it("rejects non-loopback and ipc peers regardless of forged headers", () => {
  for (const remoteAddress of ["10.0.0.1", undefined]) expect(terminalTransportAllowed({headers:{host:"localhost",origin:"http://localhost"},socket:{remoteAddress}} as any)).toBe(false);
});
it("holds the actual update/restore admission guard until terminal cleanup finishes", async () => {
  const ws = connect(await ticket()); await waitFor(ws, items => items.some(f => f.type === "ready"));
  const hooks = {idle:()=>true,pause:()=>{},resume:()=>{},flush:async()=>{}};
  await expect(maintenance.prepareUpdate("fixture-update",async()=>"prepared",hooks)).rejects.toMatchObject({status:409});
  await service.close();
  expect(await maintenance.prepareUpdate("fixture-update",async()=>"prepared",hooks)).toBe("prepared");
  maintenance.cancelUpdate("fixture-update");
});
// branding compatibility (electron/branding-compat.json): peer-http: HTTP authentication headers, discovery and domain verification still interoperate with 1.9.1; environment-aliases: legacy launchd/systemd and provider subprocess environment labels stay accepted; the central resolver always prefers the new spelling
