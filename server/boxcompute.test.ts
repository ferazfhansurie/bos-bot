import { describe, expect, it } from "vitest";

import { createBoxCompute, sandboxName, verifyKey, workspacePath } from "./boxcompute.ts";
import { DESKTOP_SCRIPT } from "./boxcompute-desktop.ts";

type Call = { method: string; path: string; headers: Record<string, string>; body?: unknown };

function fakeApi(opts: { scopes?: string[]; sandboxes?: Array<Record<string, unknown>>; pendingPolls?: number; desktopExit?: number; previewOpen?: boolean } = {}) {
  const calls: Call[] = [];
  // One preview tunnel per VM, like the real API.
  const previews = new Map<string, { previewId: string; port: number }>();
  if (opts.previewOpen) for (const entry of opts.sandboxes ?? []) previews.set(String(entry.id), { previewId: "stale", port: 6080 });
  let previewCount = 0;
  const sandboxes = [...(opts.sandboxes ?? [])];
  const workspaces: Array<{ id: string; name: string }> = [];
  let pendingPolls = opts.pendingPolls ?? 0;
  const reply = (status: number, body?: unknown, headers: Record<string, string> = {}) =>
    new Response(body === undefined ? null : body instanceof Uint8Array ? body : JSON.stringify(body), { status, headers });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace("/api/v2", "") + url.search;
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    const raw = init?.body;
    const body = typeof raw === "string" ? JSON.parse(raw) : raw;
    const method = init?.method ?? "GET";
    calls.push({ method, path, headers, body });
    if (headers.authorization !== "Bearer bc_live_good") return reply(401, { code: "UNAUTHORIZED", error: "bad key" });
    if (path === "/me") return reply(200, { account: { id: "acc" }, apiKey: { scopes: opts.scopes ?? ["sandbox:read", "sandbox:create", "sandbox:execute", "workspace:create"] } });
    if (path === "/workspaces" && method === "GET") return reply(200, { workspaces });
    if (path === "/workspaces" && method === "POST") {
      const ws = { id: "ws_1", name: (body as { name: string }).name };
      workspaces.push(ws);
      return reply(201, { workspace: ws });
    }
    if (path === "/sandboxes" && method === "GET") return reply(200, { sandboxes });
    if (path === "/sandboxes" && method === "POST") {
      const b = body as { workspaceId: string; name: string; size: string };
      const sbx = { id: `sbx_${sandboxes.length + 1}`, workspaceId: b.workspaceId, name: b.name, size: b.size, state: pendingPolls ? "pending" : "running" };
      sandboxes.push(sbx);
      return reply(202, { sandbox: sbx });
    }
    const one = path.match(/^\/sandboxes\/(sbx_\d+)(.*)$/);
    if (one) {
      const sbx = sandboxes.find((entry) => entry.id === one[1]);
      if (!sbx) return reply(404, { code: "NOT_FOUND", error: "Sandbox not found" });
      const rest = one[2];
      if (rest === "" && method === "GET") {
        if (sbx.state === "pending" && --pendingPolls <= 0) sbx.state = "running";
        return reply(200, { sandbox: sbx });
      }
      if (rest === "" && method === "DELETE") {
        sandboxes.splice(sandboxes.indexOf(sbx), 1);
        return reply(204);
      }
      if (rest === "/execute") {
        const argv = (body as { argv: string[] }).argv;
        if (argv[1] === "-c" && argv[3] === "bos-desktop") {
          const exitCode = opts.desktopExit ?? 0;
          const stdout = exitCode ? "" : argv[4] === "screenshot" ? "image/png\niVBORw0KGgo=" : argv[4] === "ensure" ? "ready\n" : "";
          return reply(200, { result: { stdout, stderr: exitCode ? "desktop install failed:\nE: no space" : "", exitCode, timedOut: false, stdoutTruncated: false, stderrTruncated: false } });
        }
        return reply(200, { result: { stdout: "hi\n", stderr: "", exitCode: 0, timedOut: false, stdoutTruncated: false, stderrTruncated: false } });
      }
      if (rest.startsWith("/files/content") && method === "PUT") return reply(204);
      if (rest.startsWith("/files/content") && method === "GET") {
        return reply(200, new TextEncoder().encode("file body"), { "x-boxcompute-eof": "true" });
      }
      if (rest.startsWith("/files/directory")) return reply(201, {});
      if (rest.startsWith("/files/list")) return reply(200, { entries: [{ name: "app", kind: "dir", size: 0 }], nextCursor: null });
      if (rest === "/previews") {
        if (previews.has(sbx.id as string)) return reply(409, { code: "PREVIEW_EXISTS", error: "The VM already has a preview tunnel" });
        const preview = { previewId: `prev_${++previewCount}`, sandboxId: sbx.id, port: (body as { port: number }).port, url: `https://x${previewCount}.bxcpreview.site/t`, expiresAt: "2026-10-17T10:00:00Z" };
        previews.set(sbx.id as string, preview);
        return reply(201, { preview });
      }
      const closed = rest.match(/^\/previews\/(\w+)$/);
      if (closed && method === "DELETE") {
        if (previews.get(sbx.id as string)?.previewId !== closed[1]) return reply(404, { code: "NOT_FOUND", error: "Preview not found" });
        previews.delete(sbx.id as string);
        return reply(204);
      }
    }
    return reply(500, { code: "UNEXPECTED", error: path });
  }) as typeof fetch;
  return { fetchImpl, calls, sandboxes };
}

const cfg = { boxCompute: { token: "bc_live_good" } };
// Fixed before the fake previews' expiry, so a cached link is still fresh.
const beforeExpiry = () => Date.parse("2026-10-17T09:00:00Z");
const onBoxCompute = { desktop: true };
const desktopCalls = (calls: Call[]) =>
  calls.filter((call) => call.path.endsWith("/execute")).map((call) => call.body as { argv: string[]; timeoutSeconds: number; maxOutputBytes: number });

describe("boxcompute", () => {
  it("verifies keys and required scopes", async () => {
    expect(await verifyKey("bc_live_good", fakeApi().fetchImpl)).toEqual({ ok: true });
    expect(await verifyKey("bc_live_bad", fakeApi().fetchImpl)).toEqual({ ok: false, message: "BoxCompute rejected this API key" });
    const narrow = await verifyKey("bc_live_good", fakeApi({ scopes: ["sandbox:read"] }).fetchImpl);
    expect(narrow).toEqual({ ok: false, message: "this BoxCompute key is missing sandbox:create, sandbox:execute" });
  });

  it("creates one workspace and one sandbox per bot, then reuses them", async () => {
    const api = fakeApi();
    const bc = createBoxCompute({ fetchImpl: api.fetchImpl, sleep: async () => {} });
    const [a, b] = await Promise.all([bc.ensure(cfg, "bot-a"), bc.ensure(cfg, "bot-a")]);
    expect(a.id).toBe(b.id);
    await bc.ensure(cfg, "bot-a");
    const other = await bc.ensure(cfg, "bot-b");
    expect(other.id).not.toBe(a.id);
    const creates = api.calls.filter((call) => call.method === "POST" && call.path === "/sandboxes");
    expect(creates).toHaveLength(2);
    expect(creates[0].headers["idempotency-key"]).toMatch(/^bos-sbx-/);
    expect(creates[0].body).toMatchObject({ workspaceId: "ws_1", name: sandboxName("bot-a"), vmSandbox: true, size: "small" });
    expect(api.calls.filter((call) => call.method === "POST" && call.path === "/workspaces")).toHaveLength(1);
    expect(api.calls.find((call) => call.path === "/workspaces" && call.method === "POST")?.headers["idempotency-key"]).toBe("bos-bot-workspace-v1");
  });

  it("waits for a pending sandbox before running a command", async () => {
    const api = fakeApi({ pendingPolls: 2 });
    const bc = createBoxCompute({ fetchImpl: api.fetchImpl, sleep: async () => {} });
    const text = await bc.runTool(cfg, "bot-a", "sandbox_exec", { command: "echo hi", cwd: "app" });
    expect(text).toBe("exit 0\nstdout:\nhi\n");
    const exec = api.calls.find((call) => call.path.endsWith("/execute"));
    expect(exec?.body).toEqual({ argv: ["bash", "-lc", "echo hi"], cwd: "/workspace/app", timeoutSeconds: 120 });
  });

  it("starts background commands detached with a short timeout", async () => {
    const api = fakeApi();
    const bc = createBoxCompute({ fetchImpl: api.fetchImpl, sleep: async () => {}, now: () => 36 });
    const text = await bc.runTool(cfg, "bot-a", "sandbox_exec", { command: "python3 -m http.server --bind '0.0.0.0'", background: true });
    expect(text).toBe("started in background, log /tmp/bos-bg-10.log\nhi\n");
    const exec = api.calls.find((call) => call.path.endsWith("/execute"))?.body as { argv: string[]; timeoutSeconds: number };
    expect(exec.timeoutSeconds).toBe(8);
    expect(exec.argv[2]).toContain(`setsid nohup bash -lc 'python3 -m http.server --bind '\\''0.0.0.0'\\''' >/tmp/bos-bg-10.log 2>&1 < /dev/null &`);
  });

  it("reports an expired sandbox instead of silently replacing it", async () => {
    const api = fakeApi();
    const bc = createBoxCompute({ fetchImpl: api.fetchImpl, sleep: async () => {} });
    await bc.ensure(cfg, "bot-a");
    api.sandboxes[0].state = "expired";
    await expect(bc.runTool(cfg, "bot-a", "sandbox_exec", { command: "ls" })).rejects.toThrow(/sandbox_reset/);
    expect(await bc.runTool(cfg, "bot-a", "sandbox_reset", {})).toMatch(/deleted/);
    expect(api.sandboxes).toHaveLength(0);
  });

  it("writes, reads, lists and previews inside /workspace", async () => {
    const api = fakeApi();
    const bc = createBoxCompute({ fetchImpl: api.fetchImpl, sleep: async () => {} });
    expect(await bc.runTool(cfg, "bot-a", "sandbox_write_file", { path: "app/index.html", content: "<h1>hi</h1>" })).toBe("wrote 11 bytes to /workspace/app/index.html");
    expect(api.calls.some((call) => call.method === "POST" && call.path.includes("/files/directory?path=%2Fworkspace%2Fapp"))).toBe(true);
    expect(await bc.runTool(cfg, "bot-a", "sandbox_read_file", { path: "/workspace/app/index.html" })).toBe("file body");
    expect(await bc.runTool(cfg, "bot-a", "sandbox_list_files", {})).toBe("d 0\tapp");
    expect(await bc.runTool(cfg, "bot-a", "sandbox_preview", { port: 3000 })).toMatch(/^https:\/\/x1\.bxcpreview\.site\/t\n/);
    await expect(bc.runTool(cfg, "bot-a", "sandbox_preview", { port: 0 })).rejects.toThrow(/port/);
  });

  it("refuses paths outside /workspace and missing keys", async () => {
    expect(workspacePath("src/a.ts")).toBe("/workspace/src/a.ts");
    expect(() => workspacePath("/etc/passwd")).toThrow();
    expect(() => workspacePath("/workspace/../etc")).toThrow();
    const bc = createBoxCompute({ fetchImpl: fakeApi().fetchImpl });
    await expect(bc.runTool({}, "bot-a", "sandbox_status", {})).rejects.toThrow(/not connected/);
  });

  it("creates a large sandbox on the BoxCompute place and drives its desktop", async () => {
    const api = fakeApi();
    const bc = createBoxCompute({ fetchImpl: api.fetchImpl, sleep: async () => {} });
    const shot = await bc.runDesktopTool(cfg, "bot-a", "sandbox_desktop_screenshot", {}, onBoxCompute);
    expect(shot.image).toEqual({ data: "iVBORw0KGgo=", mimeType: "image/png" });
    expect(shot.text).toContain("1280x800");
    expect(api.calls.find((call) => call.method === "POST" && call.path === "/sandboxes")?.body).toMatchObject({ size: "large" });
    const [first] = desktopCalls(api.calls);
    // The healing script rides along on every call, as argv, never spliced.
    expect(first.argv.slice(0, 5)).toEqual(["bash", "-c", DESKTOP_SCRIPT, "bos-desktop", "screenshot"]);
    expect(first.timeoutSeconds).toBe(600);
    expect(first.maxOutputBytes).toBe(1_048_576);

    expect((await bc.runDesktopTool(cfg, "bot-a", "sandbox_desktop_click", { x: 10.4, y: 20, double: true }, onBoxCompute)).text).toMatch(/^double-clicked 10,20/);
    await bc.runDesktopTool(cfg, "bot-a", "sandbox_desktop_click", { x: 5, y: 6, button: "right" }, onBoxCompute);
    await bc.runDesktopTool(cfg, "bot-a", "sandbox_desktop_type", { text: "hello 'world' $(rm -rf /)" }, onBoxCompute);
    await bc.runDesktopTool(cfg, "bot-a", "sandbox_desktop_key", { keys: " ctrl+l  Return " }, onBoxCompute);
    await bc.runDesktopTool(cfg, "bot-a", "sandbox_desktop_scroll", { direction: "up", amount: 99 }, onBoxCompute);
    expect((await bc.runDesktopTool(cfg, "bot-a", "sandbox_desktop_open_url", { url: "https://www.instagram.com" }, onBoxCompute)).text).toContain("https://www.instagram.com/");
    expect(desktopCalls(api.calls).slice(1).map((call) => call.argv.slice(4))).toEqual([
      ["click", "10", "20", "1", "2"],
      ["click", "5", "6", "3", "1"],
      ["type", "hello 'world' $(rm -rf /)"],
      ["key", "ctrl+l", "Return"],
      ["scroll", "640", "400", "4", "30"],
      ["open", "https://www.instagram.com/"],
    ]);

    const before = api.calls.length;
    await expect(bc.runDesktopTool(cfg, "bot-a", "sandbox_desktop_click", { x: 1280, y: 5 }, onBoxCompute)).rejects.toThrow(/x must be a pixel 0-1279/);
    await expect(bc.runDesktopTool(cfg, "bot-a", "sandbox_desktop_key", { keys: "Return; reboot" }, onBoxCompute)).rejects.toThrow(/xdotool names/);
    await expect(bc.runDesktopTool(cfg, "bot-a", "sandbox_desktop_open_url", { url: "javascript:alert(1)" }, onBoxCompute)).rejects.toThrow(/http\(s\)/);
    await expect(bc.runDesktopTool(cfg, "bot-a", "sandbox_desktop_type", { text: "x".repeat(4001) }, onBoxCompute)).rejects.toThrow(/in parts/);
    expect(api.calls.length).toBe(before);
  });

  it("keeps the desktop to the BoxCompute place and a large sandbox, rebuilt only through reset", async () => {
    const api = fakeApi({ sandboxes: [{ id: "sbx_1", workspaceId: "ws_1", name: sandboxName("bot-a"), state: "running", size: "small" }] });
    const bc = createBoxCompute({ fetchImpl: api.fetchImpl, sleep: async () => {} });
    await expect(bc.runDesktopTool(cfg, "bot-a", "sandbox_desktop_screenshot", {})).rejects.toMatchObject({ status: 403 });
    await expect(bc.runDesktopTool(cfg, "bot-a", "sandbox_desktop_screenshot", {}, onBoxCompute)).rejects.toThrow(/needs a large sandbox.*sandbox_reset/);
    // The person's files are never deleted behind the bot's back.
    expect(api.sandboxes).toHaveLength(1);
    expect(desktopCalls(api.calls)).toHaveLength(0);
    expect(await bc.runTool(cfg, "bot-a", "sandbox_reset", {}, onBoxCompute)).toMatch(/fresh large one/);
    expect((await bc.runDesktopTool(cfg, "bot-a", "sandbox_desktop_screenshot", {}, onBoxCompute)).image?.mimeType).toBe("image/png");
    expect(api.sandboxes.map((entry) => entry.size)).toEqual(["large"]);
    // Off the BoxCompute place a new sandbox stays at the configured size.
    await bc.runTool(cfg, "bot-b", "sandbox_exec", { command: "ls" });
    expect(api.sandboxes.map((entry) => entry.size)).toEqual(["large", "small"]);
  });

  it("reports a desktop that fails to come up with its own words", async () => {
    const api = fakeApi({ desktopExit: 87 });
    const bc = createBoxCompute({ fetchImpl: api.fetchImpl, sleep: async () => {} });
    await expect(bc.runDesktopTool(cfg, "bot-a", "sandbox_desktop_screenshot", {}, onBoxCompute)).rejects.toThrow(/screenshot failed \(exit 87\): desktop install failed:\nE: no space/);
  });

  it("shares one preview tunnel between the live desktop link and app previews", async () => {
    const api = fakeApi();
    const bc = createBoxCompute({ fetchImpl: api.fetchImpl, sleep: async () => {}, now: beforeExpiry });
    expect(await bc.runTool(cfg, "bot-a", "sandbox_preview", { port: 3000 }, onBoxCompute)).toMatch(/^https:\/\/x1\.bxcpreview\.site\/t\n/);
    const live = await bc.runDesktopTool(cfg, "bot-a", "sandbox_desktop_live_link", {}, onBoxCompute);
    expect(live.text.split("\n")[0]).toBe("https://x2.bxcpreview.site/t/vnc.html?autoconnect=1&resize=scale");
    expect(live.text).toContain("port 3000 stopped working");
    expect(live.text).toContain("only to the person you are working for");
    expect(api.calls.some((call) => call.method === "DELETE" && call.path.endsWith("/previews/prev_1"))).toBe(true);
    // Asking again hands back the same open link instead of a 409.
    expect((await bc.runDesktopTool(cfg, "bot-a", "sandbox_desktop_live_link", {}, onBoxCompute)).text).toBe(live.text.replace(/ The earlier.*$/, ""));
    expect(api.calls.filter((call) => call.method === "POST" && call.path.endsWith("/previews"))).toHaveLength(2);
  });

  it("explains a preview tunnel left open by an earlier session", async () => {
    const api = fakeApi({ sandboxes: [{ id: "sbx_1", workspaceId: "ws_1", name: sandboxName("bot-a"), state: "running", size: "large" }], previewOpen: true });
    const bc = createBoxCompute({ fetchImpl: api.fetchImpl, sleep: async () => {} });
    await bc.ensure(cfg, "bot-a");
    await expect(bc.runDesktopTool(cfg, "bot-a", "sandbox_desktop_live_link", {}, onBoxCompute)).rejects.toThrow(/one per VM.*within an hour/);
  });

  it("prewarm wakes an existing cold sandbox at most once a minute and never creates one", async () => {
    let clock = 1_000_000;
    const api = fakeApi({ sandboxes: [{ id: "sbx_1", workspaceId: "ws_1", name: sandboxName("bot-a"), state: "cold", size: "large" }] });
    const bc = createBoxCompute({ fetchImpl: api.fetchImpl, sleep: async () => {}, now: () => clock });
    const executes = () => api.calls.filter((call) => call.path.endsWith("/execute"));

    expect(await bc.prewarm(cfg, "bot-a")).toBe("woken");
    expect(executes().map((call) => call.body)).toEqual([{ argv: ["true"], cwd: "/workspace", timeoutSeconds: 60 }]);
    const callsAfterWake = api.calls.length;
    clock += 30_000;
    expect(await bc.prewarm(cfg, "bot-a")).toBe("deduped");
    expect(api.calls).toHaveLength(callsAfterWake);

    clock += 31_000;
    api.sandboxes[0].state = "running";
    expect(await bc.prewarm(cfg, "bot-a")).toBe("warm");
    clock += 61_000;
    api.sandboxes[0].state = "expired";
    expect(await bc.prewarm(cfg, "bot-a")).toBe("expired");
    expect(executes()).toHaveLength(1);

    // No sandbox yet: a pick must not provision (and bill) one.
    expect(await bc.prewarm(cfg, "bot-b")).toBe("none");
    expect(api.calls.filter((call) => call.method === "POST" && call.path === "/sandboxes")).toHaveLength(0);
    expect(await bc.prewarm({}, "bot-c")).toBe("unconfigured");
  });

  it("prewarm returns at once for a repeat and resolves instead of rejecting on failure", async () => {
    let hung = 0;
    const hanging = (() => { hung++; return new Promise<Response>(() => {}); }) as typeof fetch;
    const slow = createBoxCompute({ fetchImpl: hanging });
    const first = slow.prewarm(cfg, "bot-a");
    // The first wake is still waiting on the API; the repeat does not queue behind it.
    expect(await slow.prewarm(cfg, "bot-a")).toBe("deduped");
    expect(hung).toBe(1);
    void first;

    const broken = createBoxCompute({ fetchImpl: (async () => { throw new Error("network down"); }) as typeof fetch });
    await expect(broken.prewarm(cfg, "bot-a")).resolves.toBe("failed");
  });

  it("maps a rejected key to a fix the person can act on", async () => {
    const bc = createBoxCompute({ fetchImpl: fakeApi().fetchImpl });
    await expect(bc.runTool({ boxCompute: { token: "bc_live_bad" } }, "bot-a", "sandbox_status", {})).rejects.toThrow(/Settings → Connections/);
  });
});
