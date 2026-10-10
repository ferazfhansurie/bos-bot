import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserRuntime, browserRuntimeEnv, type BrowserSpawnSpec } from "./browser-runtime.ts";

const runtimes: BrowserRuntime[] = [];
function runtime(options: ConstructorParameters<typeof BrowserRuntime>[0] = {}) {
  const value = new BrowserRuntime({ requestTimeoutMs: 1_000, takeoverTimeoutMs: 100, idleMs: 1_000, ...options });
  runtimes.push(value);
  return value;
}
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
afterEach(async () => { await Promise.all(runtimes.splice(0).map((value) => value.closeAll())); });

describe("browser takeover gate", () => {
  it("immediately blocks shared-session reads and writes, while unrelated sessions work", async () => {
    const value = runtime();
    const action = deferred<string>();
    const pending = value.withAgentAction("shared-profile", () => action.promise);
    const observed = expect(pending).rejects.toThrow(/paused/);
    const taking = value.take("shared-profile", "person");
    expect(value.heldBy("shared-profile")).toBe("person");
    expect(value.canControl("shared-profile", "person")).toBe(false);
    const screenshot = vi.fn();
    await expect(value.withAgentAction("shared-profile", screenshot)).rejects.toThrow(/paused/);
    expect(screenshot).not.toHaveBeenCalled();
    await expect(value.withAgentAction("different-profile", async () => 42)).resolves.toBe(42);
    action.resolve("old screenshot never reaches bot");
    await observed;
    await taking;
    expect(value.canControl("shared-profile", "person")).toBe(true);
    expect(value.canControl("shared-profile", "other-person")).toBe(false);
  });

  it("retains a non-controllable hold when draining times out, even if the action finishes later", async () => {
    const value = runtime({ takeoverTimeoutMs: 20 });
    const action = deferred();
    const pending = value.withAgentAction("s", () => action.promise);
    const observed = expect(pending).rejects.toThrow(/paused/);
    await expect(value.take("s", "owner")).rejects.toThrow(/still finishing/);
    expect(value.heldBy("s")).toBe("owner");
    action.resolve();
    await observed;
    expect(value.canControl("s", "owner")).toBe(false);
    await value.take("s", "owner");
    expect(value.canControl("s", "owner")).toBe(true);
  });

  it("only the owner can release, and pending human actions drain before agents resume", async () => {
    const value = runtime();
    await value.take("s", "owner");
    await expect(value.take("s", "other")).rejects.toThrow(/Another person/);
    value.release("s", "other");
    expect(value.heldBy("s")).toBe("owner");
    const typed = deferred();
    const human = value.withHumanAction("s", "owner", () => typed.promise);
    value.release("s", "owner");
    expect(value.canControl("s", "owner")).toBe(false);
    expect(value.heldBy("s")).toBe("owner");
    await expect(value.withAgentAction("s", async () => "snapshot")).rejects.toThrow(/paused/);
    await expect(value.withHumanAction("s", "owner", async () => "click")).rejects.toThrow(/Take control/);
    typed.resolve();
    await human;
    expect(value.heldBy("s")).toBeNull();
    await expect(value.withAgentAction("s", async () => "safe screenshot")).resolves.toBe("safe screenshot");
  });

  it("release cancels an in-flight take and does not grant control afterwards", async () => {
    const value = runtime();
    const action = deferred();
    const pending = value.withAgentAction("s", () => action.promise);
    const taking = value.take("s", "owner");
    const observed = expect(taking).rejects.toThrow(/cancelled/);
    value.release("s", "owner");
    await observed;
    action.resolve();
    await pending;
    expect(value.canControl("s", "owner")).toBe(false);
  });

  it("failed actions release their counters and closing a transport does not release the owner", async () => {
    const value = runtime();
    await expect(value.withAgentAction("s", async () => { throw new Error("bad action"); })).rejects.toThrow("bad action");
    await value.take("s", "owner");
    await value.close("s");
    expect(value.heldBy("s")).toBe("owner");
    expect(value.canControl("s", "owner")).toBe(false);
    await value.take("s", "owner");
    expect(value.canControl("s", "owner")).toBe(true);
  });

  it("does not resume agents after an interrupted human command until browser recovery", async () => {
    const value = runtime();
    await value.take("s", "owner");
    await expect(value.withHumanAction("s", "owner", async () => { throw new Error("navigation timed out"); })).rejects.toThrow(/timed out/);
    value.release("s", "owner");
    await expect(value.withAgentAction("s", async () => "snapshot")).rejects.toThrow(/agent_browser_open/);
    await expect(value.take("s", "owner")).rejects.toThrow(/may still be running/);
    await value.close("s");
    value.release("s", "owner");
    await expect(value.withAgentAction("s", async () => "recovered")).resolves.toBe("recovered");
  });

  it("requires recovery for abandoned pressed input, but ignores stale or unrelated owners", async () => {
    const value = runtime();
    await value.take("s", "owner");
    value.abandonHumanInput("s", "other");
    expect(value.canControl("s", "owner")).toBe(true);
    value.abandonHumanInput("s", "owner");
    expect(value.canControl("s", "owner")).toBe(false);
    value.release("s", "owner");
    await expect(value.withAgentAction("s", async () => "click with stuck modifier")).rejects.toThrow(/agent_browser_open/);
    await value.restart("s", "new-viewer", async () => {});
    value.abandonHumanInput("s", "owner");
    await expect(value.withAgentAction("s", async () => "fresh input state")).resolves.toBe("fresh input state");
  });

  it("restarts exclusively and retains an uncertain hold if native close fails", async () => {
    const value = runtime();
    await expect(value.restart("s", "recovery", async () => { throw new Error("close timed out"); })).rejects.toThrow(/timed out/);
    expect(value.heldBy("s")).toBe("recovery");
    expect(value.canControl("s", "recovery")).toBe(false);
    const closing = deferred();
    const restart = value.restart("s", "recovery", () => closing.promise);
    await expect(value.withAgentAction("s", async () => "click")).rejects.toThrow(/paused/);
    await expect(value.withHumanAction("s", "recovery", async () => "click")).rejects.toThrow(/Take control/);
    closing.resolve();
    await restart;
    expect(value.heldBy("s")).toBeNull();
    await expect(value.withAgentAction("s", async () => "recovered")).resolves.toBe("recovered");
  });

  it("will not restart active actions or another person's held browser", async () => {
    const value = runtime();
    const nativeClose = vi.fn(async () => {});
    const busy = deferred();
    const agent = value.withAgentAction("s", () => busy.promise);
    await expect(value.restart("s", "recovery", nativeClose)).rejects.toThrow(/busy/);
    busy.resolve();
    await agent;
    await value.take("s", "other");
    await expect(value.restart("s", "recovery", nativeClose)).rejects.toThrow(/Another person/);
    expect(nativeClose).not.toHaveBeenCalled();
  });
});

const FAKE_MCP = `
const lines = require('node:readline').createInterface({input:process.stdin});
let initialized = false;
lines.on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'notifications/initialized') { initialized = true; return; }
  let result;
  if (m.method === 'initialize') result = { protocolVersion:'2024-11-05',capabilities:{tools:{}} };
  else if (m.method === 'tools/list' && m.params && m.params.hang) return;
  else if (m.method === 'tools/list') result = { tools:[{name:'echo'}],pid:process.pid,initialized };
  else if (m.params.name === 'hang') return;
  else if (m.params.name === 'crash') process.exit(23);
  else if (m.params.name === 'exit-idle') { process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{content:[]}})+'\\n'); setTimeout(() => process.exit(0), 20); return; }
  else if (m.params.name === 'oversized') { process.stdout.write('x'.repeat(16777217)); return; }
  else if (m.params.name === 'bulky') result = { content:[{type:'text',text:'x'.repeat(50000)},{type:'image',data:'AAAA',mimeType:'image/png'}], structuredContent:{ huge: 'y'.repeat(200000) } };
  else if (m.params.name === 'rpc-error') { process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-1,message:'Expected refusal'}})+'\\n'); return; }
  else result = { content:[{type:'text',text:JSON.stringify(m.params)}],pid:process.pid };
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
});
`;
const spec = (): BrowserSpawnSpec => ({ command: process.execPath, args: ["-e", FAKE_MCP], env: { PATH: process.env.PATH } });

describe("server-owned browser MCP runtime", () => {
  it("inherits only host plumbing and explicit engine settings", () => {
    vi.stubEnv("OPENAI_API_KEY", "must-not-inherit");
    try {
      const env = browserRuntimeEnv({ HOME: "/isolated/browser-home", AGENT_BROWSER_SESSION: "fixture" });
      expect(env.HOME).toBe("/isolated/browser-home");
      expect(env.AGENT_BROWSER_SESSION).toBe("fixture");
      expect(env.PATH).toBe(process.env.PATH);
      expect(env.OPENAI_API_KEY).toBeUndefined();
    } finally { vi.unstubAllEnvs(); }
  });

  it("rechecks a revoked capability after initialization and before forwarding", async () => {
    const value = runtime();
    let valid = true;
    const check = () => { if (!valid) throw new Error("capability revoked"); };
    const pending = value.agentRpc("s", spec(), "tools/call", { name: "crash" }, check);
    valid = false;
    await expect(pending).rejects.toThrow(/revoked/);
    await expect(value.agentRpc("s", spec(), "tools/list", {})).resolves.toMatchObject({ initialized: true });
    await value.take("s", "owner");
    expect(value.canControl("s", "owner")).toBe(true);
  });
  it("does not assume an MCP timeout stopped an accepted daemon action", async () => {
    const value = runtime({ requestTimeoutMs: 60 });
    // Advance only the deliberately hung request's deadline. Real subprocess
    // startup/stdio remain live, so a loaded runner cannot time out a healthy
    // recovery echo merely because its 60 ms scheduling window elapsed.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await expect(value.agentRpc("s", spec(), "tools/list", {})).resolves.toMatchObject({ initialized: true });
      const pending = value.agentRpc("s", spec(), "tools/call", { name: "hang" });
      const observed = expect(pending).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(60);
      await observed;
      // The real daemon detaches from its MCP parent. Transport exit is not
      // proof that a navigation or submission stopped; do not replay it.
      await expect(value.agentRpc("s", spec(), "tools/call", { name: "echo" })).rejects.toThrow(/agent_browser_open/);
      await expect(value.take("s", "owner")).rejects.toThrow(/Restart/);
      await value.restart("s", "owner", async () => {});
      await expect(value.agentRpc("s", spec(), "tools/call", { name: "echo", arguments: { text: "back" } }))
        .resolves.toMatchObject({ content: [{ text: expect.stringContaining("back") }] });
      await value.take("s", "owner");
      expect(value.canControl("s", "owner")).toBe(true);
    } finally {
      // Process-tree cleanup polls real child exits with timers of its own.
      vi.useRealTimers();
      await value.closeAll();
    }
  });

  it("still refuses an agent after a human's own interrupted command, browser alive", async () => {
    // The other half of the contract: this uncertainty is NOT self-resolving,
    // because the browser is still running and may act again.
    const value = runtime();
    await value.agentRpc("s", spec(), "tools/list", {});
    await value.take("s", "owner");
    await expect(value.withHumanAction("s", "owner", async () => { throw new Error("navigation timed out"); })).rejects.toThrow(/timed out/);
    value.release("s", "owner");
    await expect(value.withAgentAction("s", async () => "snapshot")).rejects.toThrow(/agent_browser_open/);
  });

  it("initializes once, reuses its own session client, and supports concurrent ids", async () => {
    const value = runtime();
    const list = await value.agentRpc("one", spec(), "tools/list", {}) as { pid: number; initialized: boolean };
    expect(list.initialized).toBe(true);
    const responses = await Promise.all(["first", "second"].map((text) => value.agentRpc("one", spec(), "tools/call", { name: "echo", arguments: { text } }))) as Array<{ pid: number; content: Array<{ text: string }> }>;
    expect(responses.map((r) => r.pid)).toEqual([list.pid, list.pid]);
    expect(responses[0].content[0].text).toContain("first");
    expect(responses[1].content[0].text).toContain("second");
    const other = await value.agentRpc("two", spec(), "tools/list", {}) as { pid: number };
    expect(other.pid).not.toBe(list.pid);
    await value.take("one", "owner");
    await expect(value.agentRpc("one", spec(), "tools/call", { name: "echo" })).rejects.toThrow(/paused/);
    await expect(value.agentRpc("one", spec(), "tools/list", {})).resolves.toMatchObject({ tools: [{ name: "echo" }] });
  });

  it("keeps completed MCP refusals distinct from uncertain transport failure", async () => {
    const value = runtime();
    await expect(value.agentRpc("s", spec(), "tools/call", { name: "rpc-error" })).rejects.toThrow("Expected refusal");
    await value.take("s", "owner");
    expect(value.canControl("s", "owner")).toBe(true);
  });

  it.each(["hang", "crash", "oversized"])("fails closed on %s, and can reconnect after explicit close", async (name) => {
    const value = runtime({ requestTimeoutMs: 250 });
    await expect(value.agentRpc("s", spec(), "tools/call", { name })).rejects.toThrow(/Browser/);
    await expect(value.take("s", "owner")).rejects.toThrow(/may still be running/);
    expect(value.canControl("s", "owner")).toBe(false);
    value.release("s", "owner");
    await value.close("s");
    await expect(value.agentRpc("s", spec(), "tools/call", { name: "echo" })).resolves.toMatchObject({ content: [{ type: "text" }] });
  });

  it("rejects oversized requests without poisoning the session", async () => {
    const value = runtime();
    await expect(value.agentRpc("s", spec(), "tools/call", { name: "echo", arguments: { text: "x".repeat(1_048_577) } })).rejects.toThrow(/size limit/);
    await value.take("s", "owner");
    expect(value.canControl("s", "owner")).toBe(true);
  });

  it("bounds concurrent requests without queuing more work behind a hung action", async () => {
    const value = runtime({ maxPending: 1, requestTimeoutMs: 250 });
    await value.agentRpc("s", spec(), "tools/list", {});
    const pending = value.agentRpc("s", spec(), "tools/call", { name: "hang" });
    const observed = expect(pending).rejects.toThrow(/timed out/);
    await Promise.resolve();
    await expect(value.agentRpc("s", spec(), "tools/list", {})).rejects.toThrow(/Too many pending/);
    await observed;
  });

  it("evicts idle transports without dropping a human hold", async () => {
    const value = runtime({ idleMs: 30 });
    const before = await value.agentRpc("s", spec(), "tools/list", {}) as { pid: number };
    await value.take("s", "owner");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(value.heldBy("s")).toBe("owner");
    const after = await value.agentRpc("s", spec(), "tools/list", {}) as { pid: number };
    expect(after.pid).not.toBe(before.pid);
  });

  it.each([false, true])("retires an idle MCP client without killing its browser descendant (ignores EOF: %s)", async (ignoresEof) => {
    // Windows taskkill /T includes even a daemon with its own process group.
    // This inert descendant models that ownership boundary on every platform.
    // unref alone does not detach a Windows child from its parent's console.
    // Keep the POSIX group shared so an accidental group kill still fails here.
    const fake = `
      const browser = require('node:child_process').spawn(process.execPath,
        ['-e', 'process.stdout.write("ready"); setInterval(() => {}, 1000)'],
        { stdio: ['ignore', 'pipe', 'ignore'], detached: process.platform === 'win32', windowsHide: true });
      browser.unref();
      let ready = false;
      let pending = null;
      const flush = () => {
        if (!ready || !pending) return;
        const m = pending; pending = null;
        const result = m.method === 'initialize' ? { protocolVersion: '2024-11-05' }
          : { tools: [], browserPid: browser.pid, transportPid: process.pid };
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
      };
      browser.stdout.once('data', () => { ready = true; browser.stdout.destroy(); flush(); });
      browser.stdout.on('error', () => {});
      ${ignoresEof ? "setInterval(() => {}, 1000);" : ""}
      require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
        const m = JSON.parse(line);
        if (!m.id) return;
        pending = m; flush();
      });

    `;
    const value = runtime({ idleMs: 40 });
    const launch = { command: process.execPath, args: ["-e", fake], env: {} };
    const first = await value.agentRpc("idle", launch, "tools/list", {}) as { browserPid: number; transportPid: number };
    try {
      expect(() => process.kill(first.browserPid, 0)).not.toThrow();
      await vi.waitFor(() => expect(() => process.kill(first.transportPid, 0)).toThrow(), { timeout: 2_000, interval: 30 });
      expect(() => process.kill(first.browserPid, 0)).not.toThrow();
    } finally {
      try { process.kill(first.browserPid, "SIGKILL"); } catch { /* fixture exited */ }
    }
  });
});

describe("agent self-recovery from an uncertain browser", () => {
  async function latched(closeBrowser = vi.fn(async (_session: string, _spec: BrowserSpawnSpec) => true)) {
    const value = runtime({ requestTimeoutMs: 250, closeBrowser });
    const before = await value.agentRpc("s", spec(), "tools/list", {}) as { pid: number };
    await expect(value.agentRpc("s", spec(), "tools/call", { name: "crash" })).rejects.toThrow(/Browser/);
    return { value, closeBrowser, before };
  }

  it("refuses other tools with a hint the model can act on, and keeps tools/list available", async () => {
    const { value, closeBrowser } = await latched();
    await expect(value.agentRpc("s", spec(), "tools/call", { name: "agent_browser_snapshot" })).rejects.toThrow(/Call agent_browser_open/);
    await expect(value.agentRpc("s", spec(), "tools/list", {})).resolves.toMatchObject({ tools: [{ name: "echo" }] });
    expect(closeBrowser).not.toHaveBeenCalled();
  });

  it("agent_browser_open closes the native browser and the old transport, then opens fresh", async () => {
    const { value, closeBrowser } = await latched();
    const stale = await value.agentRpc("s", spec(), "tools/list", {}) as { pid: number };
    const order: string[] = [];
    const check = vi.fn(() => { order.push("check"); });
    closeBrowser.mockImplementationOnce(async (session, launch) => {
      order.push("close");
      expect(session).toBe("s");
      expect(launch.command).toBe(process.execPath);
      // Nothing else is admitted while the browser closes.
      await expect(value.agentRpc("s", spec(), "tools/call", { name: "echo" })).rejects.toThrow(/agent_browser_open/);
      await expect(value.take("s", "owner")).rejects.toThrow(/changing/);
      return true;
    });
    const opened = await value.agentRpc("s", spec(), "tools/call", { name: "agent_browser_open", arguments: { url: "https://example.com" } }, check) as { pid: number; content: Array<{ text: string }> };
    expect(order[0]).toBe("check"); // the turn's claim is checked before anything is closed
    expect(order).toContain("close");
    expect(closeBrowser).toHaveBeenCalledTimes(1);
    expect(opened.content[0].text).toContain("example.com");
    expect(opened.pid).not.toBe(stale.pid);
    await expect(value.agentRpc("s", spec(), "tools/call", { name: "echo" })).resolves.toMatchObject({ content: [{ type: "text" }] });
    await value.take("s", "owner");
    expect(value.canControl("s", "owner")).toBe(true);
  });

  it("agent_browser_close recovers without dispatching to the engine", async () => {
    const { value, closeBrowser } = await latched();
    await expect(value.agentRpc("s", spec(), "tools/call", { name: "agent_browser_close" }))
      .resolves.toMatchObject({ content: [{ type: "text", text: expect.stringContaining("Browser closed") }] });
    expect(closeBrowser).toHaveBeenCalledTimes(1);
    await expect(value.agentRpc("s", spec(), "tools/call", { name: "echo" })).resolves.toMatchObject({ content: [{ type: "text" }] });
  });

  it("stays latched when the native close fails or the turn may not use the browser", async () => {
    const { value, closeBrowser } = await latched(vi.fn(async () => false));
    await expect(value.agentRpc("s", spec(), "tools/call", { name: "agent_browser_open" })).rejects.toThrow(/could not be restarted/);
    await expect(value.agentRpc("s", spec(), "tools/call", { name: "echo" })).rejects.toThrow(/agent_browser_open/);
    closeBrowser.mockClear();
    const otherThread = () => { throw new Error("another thread is using this browser"); };
    await expect(value.agentRpc("s", spec(), "tools/call", { name: "agent_browser_open" }, otherThread)).rejects.toThrow(/another thread/);
    expect(closeBrowser).not.toHaveBeenCalled();
    closeBrowser.mockResolvedValueOnce(true);
    await expect(value.agentRpc("s", spec(), "tools/call", { name: "agent_browser_open" })).resolves.toMatchObject({ content: [{ type: "text" }] });
  });

  it("never steals a person's control or restarts over running work", async () => {
    const closeBrowser = vi.fn(async () => true);
    const value = runtime({ closeBrowser });
    await value.take("s", "owner");
    await expect(value.withHumanAction("s", "owner", async () => { throw new Error("navigation timed out"); })).rejects.toThrow(/timed out/);
    // A person still holds the uncertain browser: refused, their hold kept.
    await expect(value.agentRpc("s", spec(), "tools/call", { name: "agent_browser_open" })).rejects.toThrow(/paused/);
    expect(value.heldBy("s")).toBe("owner");
    // Held input drains first: releasing with a human action still running is busy.
    const typing = deferred();
    const value2 = runtime({ closeBrowser });
    await value2.take("t", "owner");
    const human = value2.withHumanAction("t", "owner", () => typing.promise);
    value2.abandonHumanInput("t", "owner");
    value2.release("t", "owner");
    await expect(value2.agentRpc("t", spec(), "tools/call", { name: "agent_browser_open" })).rejects.toThrow(/paused/);
    typing.resolve();
    await human;
    expect(closeBrowser).not.toHaveBeenCalled();
    // Once the person's hold is gone, closing the browser clears their held keys.
    value.release("s", "owner");
    await expect(value.agentRpc("s", spec(), "tools/call", { name: "agent_browser_open" })).resolves.toMatchObject({ content: [{ type: "text" }] });
    expect(closeBrowser).toHaveBeenCalledTimes(1);
  });

  it("refuses while another agent action is still in flight", async () => {
    const closeBrowser = vi.fn(async () => true);
    const value = runtime({ closeBrowser });
    const running = deferred();
    const agent = value.withAgentAction("s", () => running.promise);
    // Model the latch from another source while that action runs.
    (value as unknown as { gate(s: string): { uncertain: boolean } }).gate("s").uncertain = true;
    await expect(value.agentRpc("s", spec(), "tools/call", { name: "agent_browser_open" })).rejects.toThrow(/busy/);
    expect(closeBrowser).not.toHaveBeenCalled();
    running.resolve();
    await agent;
  });

  it("without a configured native close, an agent cannot recover and is told how", async () => {
    const value = runtime({ requestTimeoutMs: 250 });
    await expect(value.agentRpc("s", spec(), "tools/call", { name: "crash" })).rejects.toThrow(/Browser/);
    await expect(value.agentRpc("s", spec(), "tools/call", { name: "agent_browser_open" })).rejects.toThrow(/agent_browser_open/);
  });
});

describe("uncertainty latches only for an in-flight action", () => {
  it("does not latch when the transport exits idle", async () => {
    const value = runtime();
    await expect(value.agentRpc("s", spec(), "tools/call", { name: "exit-idle" })).resolves.toMatchObject({ content: [] });
    await new Promise((resolve) => setTimeout(resolve, 150));
    await expect(value.agentRpc("s", spec(), "tools/call", { name: "echo" })).resolves.toMatchObject({ content: [{ type: "text" }] });
    await value.take("s", "owner");
    expect(value.canControl("s", "owner")).toBe(true);
  });

  it("does not latch when a tools/list times out", async () => {
    const value = runtime({ requestTimeoutMs: 200 });
    await expect(value.agentRpc("s", spec(), "tools/list", { hang: true })).rejects.toThrow(/timed out/);
    await expect(value.agentRpc("s", spec(), "tools/call", { name: "echo" })).resolves.toMatchObject({ content: [{ type: "text" }] });
  });
});

describe("browser MCP shaping at the runtime boundary", () => {
  it("strips harness-owned arguments before dispatch and bounds what a result puts into the conversation", async () => {
    const value = new BrowserRuntime({ idleMs: 500 });
    try {
      const echoed = await value.agentRpc("shape", spec(), "tools/call", { name: "echo", arguments: { text: "hi", session: "other-bot", extraArgs: ["--x"] } }) as { content: Array<{ text: string }> };
      expect(JSON.parse(echoed.content[0].text)).toEqual({ name: "echo", arguments: { text: "hi" } });
      const bulky = await value.agentRpc("shape", spec(), "tools/call", { name: "bulky" }) as Record<string, unknown> & { content: Array<{ type: string; text?: string }> };
      expect(bulky).not.toHaveProperty("structuredContent");
      expect(bulky.content).toHaveLength(2);
      expect(bulky.content[0].text!.length).toBeLessThan(33_000);
      expect(bulky.content[0].text).toContain("trimmed this tool result");
      expect(bulky.content[1]).toMatchObject({ type: "image" });
    } finally { await value.closeAll(); }
  });
});
