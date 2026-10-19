// BoxCompute (boxcompute.ai) sandboxes: one Linux VM per bot, hosted in
// Malaysia. The API key never leaves this process — agents call the
// sandbox_* tools, the stdio proxy relays them to the harness, and the
// harness calls BoxCompute here with the workspace key.
import { randomUUID } from "node:crypto";
import { compatEnv } from "../electron/branding-env.cjs";
import { BoxComputeError } from "./boxcompute-error.ts";
import {
  DESKTOP_HEIGHT,
  DESKTOP_TIMEOUT_SECONDS,
  DESKTOP_TOOL_NAMES,
  DESKTOP_VNC_PORT,
  DESKTOP_WIDTH,
  desktopAction,
  desktopArgv,
  isDesktopTool,
  liveLinkUrl,
} from "./boxcompute-desktop.ts";

export type BoxComputeConfig = { boxCompute?: { token?: string; size?: "small" | "large" } };
type Fetch = typeof fetch;

/** Per-turn facts the harness knows and the agent cannot assert. */
export type SandboxTurn = {
  /** The turn's place is BoxCompute: the cloud desktop is offered and a new
   * sandbox is created large, because a small VM OOM-kills Chrome. */
  desktop?: boolean;
};

export type SandboxToolResult = { text: string; image?: { data: string; mimeType: string } };

/** What a background wake found. Only "woken" spent an API execute. */
export type PrewarmResult = "woken" | "warm" | "starting" | "none" | "expired" | "deduped" | "busy" | "unconfigured" | "failed";

export type Sandbox = {
  id: string;
  workspaceId: string;
  name?: string;
  state: "cold" | "pending" | "running" | "expired";
  size?: string;
  lastUsedAt?: number | null;
};

const WORKSPACE_NAME = "BOS Bot";
// Account-scoped and only valid for 24h, so a lost response within that
// window replays the same workspace instead of minting another (max 10).
const WORKSPACE_KEY = "bos-bot-workspace-v1";
const PENDING_POLL_MS = 2_000;
const PENDING_LIMIT_MS = 120_000;
const MAX_READ_BYTES = 256 * 1024;
const MAX_WRITE_BYTES = 8 * 1024 * 1024;
// A pick, a focus and a reopen often land within seconds of each other.
const PREWARM_DEDUPE_MS = 60_000;

export { BoxComputeError };

function apiBase(): string {
  return (compatEnv.OMB_BOXCOMPUTE_API ?? "https://api.boxcompute.ai").replace(/\/+$/, "") + "/api/v2";
}

export function sandboxName(botId: string): string {
  return `bos-${botId}`.slice(0, 80);
}

async function call(
  token: string,
  method: string,
  path: string,
  init: { body?: unknown; raw?: Uint8Array; idempotencyKey?: string; fetchImpl?: Fetch; timeoutMs?: number } = {},
): Promise<Response> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  let body: RequestInit["body"];
  if (init.raw) {
    headers["content-type"] = "application/octet-stream";
    body = init.raw;
  } else if (init.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  if (init.idempotencyKey) headers["idempotency-key"] = init.idempotencyKey;
  const res = await (init.fetchImpl ?? fetch)(`${apiBase()}${path}`, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(init.timeoutMs ?? 960_000),
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as { code?: string; error?: string } | null;
    throw new BoxComputeError(explain(res.status, detail?.code, detail?.error), res.status, detail?.code);
  }
  return res;
}

function explain(status: number, code: string | undefined, error: string | undefined): string {
  if (status === 401) return "BoxCompute rejected the API key — replace it in Settings → Connections";
  if (code === "INSUFFICIENT_SCOPE") return "the BoxCompute key is missing a scope (needs sandbox:read, sandbox:create, sandbox:execute, workspace:create)";
  if (status === 402) return "the BoxCompute account is out of credit";
  if (code === "WORKSPACE_QUOTA_EXCEEDED") return "the BoxCompute account is at its sandbox limit — delete an unused sandbox at app.boxcompute.ai";
  return `BoxCompute ${status}${code ? ` ${code}` : ""}${error ? `: ${error}` : ""}`;
}

async function getJson<T>(token: string, method: string, path: string, init: Parameters<typeof call>[3] = {}): Promise<T> {
  const res = await call(token, method, path, init);
  return (await res.json()) as T;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Settings check before a key is stored. Short timeout: config saves wait on it. */
export async function verifyKey(token: string, fetchImpl?: Fetch): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    // One retry on a network failure (not an API answer): a dropped first
    // connection should not make a good key look bad in Settings.
    const me = await getJson<{ apiKey?: { scopes?: string[] } }>(token, "GET", "/me", { fetchImpl, timeoutMs: 15_000 }).catch((error) => {
      if (error instanceof BoxComputeError) throw error;
      return getJson<{ apiKey?: { scopes?: string[] } }>(token, "GET", "/me", { fetchImpl, timeoutMs: 15_000 });
    });
    const scopes = new Set(me.apiKey?.scopes ?? []);
    const missing = ["sandbox:read", "sandbox:create", "sandbox:execute"].filter((scope) => !scopes.has(scope));
    if (missing.length) return { ok: false, message: `this BoxCompute key is missing ${missing.join(", ")}` };
    return { ok: true };
  } catch (error) {
    if (error instanceof BoxComputeError && error.status === 401) return { ok: false, message: "BoxCompute rejected this API key" };
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export function createBoxCompute(deps: { fetchImpl?: Fetch; sleep?: (ms: number) => Promise<void>; now?: () => number } = {}) {
  const fetchImpl = deps.fetchImpl;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  let workspace: { token: string; id: string } | null = null;
  // One in-flight provision per bot, so parallel tool calls share it, and
  // the create key survives a lost response for the life of the process.
  const provisioning = new Map<string, Promise<Sandbox>>();
  const createKeys = new Map<string, string>();
  const lastPrewarm = new Map<string, number>();

  async function workspaceId(token: string): Promise<string> {
    if (workspace?.token === token) return workspace.id;
    const { workspaces } = await getJson<{ workspaces: Array<{ id: string; name: string }> }>(token, "GET", "/workspaces", { fetchImpl });
    let id = workspaces.find((entry) => entry.name === WORKSPACE_NAME)?.id;
    if (!id) {
      const created = await getJson<{ workspace: { id: string } }>(token, "POST", "/workspaces", {
        body: { name: WORKSPACE_NAME },
        idempotencyKey: WORKSPACE_KEY,
        fetchImpl,
      });
      id = created.workspace.id;
    }
    workspace = { token, id };
    return id;
  }

  async function find(token: string, botId: string): Promise<Sandbox | null> {
    const ws = await workspaceId(token);
    const { sandboxes } = await getJson<{ sandboxes: Sandbox[] }>(token, "GET", "/sandboxes", { fetchImpl });
    const mine = sandboxes.filter((entry) => entry.workspaceId === ws && entry.name === sandboxName(botId));
    return mine.find((entry) => entry.state !== "expired") ?? mine[0] ?? null;
  }

  async function waitRunning(token: string, sandbox: Sandbox): Promise<Sandbox> {
    const deadline = now() + PENDING_LIMIT_MS;
    let current = sandbox;
    while (current.state === "pending") {
      if (now() > deadline) throw new BoxComputeError("the sandbox is still starting — try again in a minute", 504);
      await sleep(PENDING_POLL_MS);
      current = (await getJson<{ sandbox: Sandbox }>(token, "GET", `/sandboxes/${encodeURIComponent(current.id)}`, { fetchImpl })).sandbox;
    }
    return current;
  }

  async function provision(cfg: BoxComputeConfig, botId: string, turn: SandboxTurn): Promise<Sandbox> {
    const token = cfg.boxCompute?.token?.trim();
    if (!token) throw new BoxComputeError("BoxCompute is not connected — add the API key in Settings → Connections", 412);
    const existing = await find(token, botId);
    if (existing) {
      if (existing.state === "expired") {
        throw new BoxComputeError("this bot's sandbox expired — call sandbox_reset to get a fresh one (its files are gone)", 410);
      }
      return waitRunning(token, existing);
    }
    let key = createKeys.get(botId);
    if (!key) {
      key = `bos-sbx-${randomUUID()}`;
      createKeys.set(botId, key);
    }
    const created = await getJson<{ sandbox: Sandbox }>(token, "POST", "/sandboxes", {
      body: {
        workspaceId: await workspaceId(token),
        name: sandboxName(botId),
        vmSandbox: true,
        size: turn.desktop || cfg.boxCompute?.size === "large" ? "large" : "small",
      },
      idempotencyKey: key,
      fetchImpl,
    });
    createKeys.delete(botId);
    return waitRunning(token, created.sandbox);
  }

  function ensure(cfg: BoxComputeConfig, botId: string, turn: SandboxTurn = {}): Promise<Sandbox> {
    const inflight = provisioning.get(botId);
    if (inflight) return inflight;
    const next = provision(cfg, botId, turn).finally(() => provisioning.delete(botId));
    provisioning.set(botId, next);
    return next;
  }

  function token(cfg: BoxComputeConfig): string {
    const value = cfg.boxCompute?.token?.trim();
    if (!value) throw new BoxComputeError("BoxCompute is not connected — add the API key in Settings → Connections", 412);
    return value;
  }

  const sbx = (id: string) => `/sandboxes/${encodeURIComponent(id)}`;

  // BoxCompute allows one preview tunnel per VM. Remember the open one so
  // asking for the same port again reuses it and asking for another port
  // closes it first, instead of failing with 409 for the rest of the hour.
  type Preview = { previewId: string; port: number; url: string; expiresAt: string };
  const previews = new Map<string, Preview>();

  async function openPreview(key: string, sandboxId: string, port: number): Promise<Preview & { replaced?: number }> {
    const open = previews.get(sandboxId);
    if (open && open.port === port && Date.parse(open.expiresAt) - now() > 120_000) return open;
    let replaced: number | undefined;
    if (open) {
      previews.delete(sandboxId);
      await call(key, "DELETE", `${sbx(sandboxId)}/previews/${encodeURIComponent(open.previewId)}`, { fetchImpl }).catch(() => {});
      if (open.port !== port && Date.parse(open.expiresAt) > now()) replaced = open.port;
    }
    try {
      const { preview } = await getJson<{ preview: Preview }>(key, "POST", `${sbx(sandboxId)}/previews`, { body: { port }, fetchImpl });
      previews.set(sandboxId, preview);
      return { ...preview, replaced };
    } catch (error) {
      if (error instanceof BoxComputeError && error.status === 409) {
        throw new BoxComputeError(
          "this sandbox already has a public link open from an earlier session (BoxCompute allows one per VM); it closes within an hour of when it was made. A desktop link you shared before still works until then.",
          409,
          error.code,
        );
      }
      throw error;
    }
  }

  /** One sandbox tool call for one bot. Returns text for the agent. */
  async function runTool(cfg: BoxComputeConfig, botId: string, name: string, args: Record<string, unknown>, turn: SandboxTurn = {}): Promise<string> {
    const key = token(cfg);
    const str = (field: string) => (typeof args[field] === "string" ? (args[field] as string) : "");
    const path = (field = "path") => workspacePath(str(field) || "/workspace");
    switch (name) {
      case "sandbox_status": {
        const sandbox = await find(key, botId);
        if (!sandbox) return "No sandbox yet. The first sandbox_* command creates one (Linux VM, /workspace persists between calls).";
        return JSON.stringify({ id: sandbox.id, state: sandbox.state, size: sandbox.size ?? null });
      }
      case "sandbox_exec": {
        const command = str("command");
        if (!command.trim()) throw new BoxComputeError("command is required", 400);
        const sandbox = await ensure(cfg, botId, turn);
        // BoxCompute's execute waits for every process the command started,
        // even a detached one, until the timeout. A background start runs
        // detached with a short timeout and reports the pid and log instead;
        // the process keeps running after the call returns.
        const background = args.background === true;
        const log = `/tmp/bos-bg-${now().toString(36)}.log`;
        const argv = background
          ? ["bash", "-lc", `setsid nohup bash -lc ${shellQuote(command)} >${log} 2>&1 < /dev/null & echo "pid $!"; sleep 3; tail -c 2000 ${log}`]
          : ["bash", "-lc", command];
        const timeout = background ? 8 : Math.min(900, Math.max(1, Math.floor(Number(args.timeout_seconds) || 120)));
        const { result } = await getJson<{
          result: { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; stdoutTruncated: boolean; stderrTruncated: boolean };
        }>(key, "POST", `${sbx(sandbox.id)}/execute`, {
          body: { argv, cwd: path("cwd"), timeoutSeconds: timeout },
          fetchImpl,
        });
        if (background) return `started in background, log ${log}\n${result.stdout}`;
        const parts = [`exit ${result.timedOut ? "timeout" : result.exitCode}`];
        if (result.stdout) parts.push(`stdout${result.stdoutTruncated ? " (truncated)" : ""}:\n${result.stdout}`);
        if (result.stderr) parts.push(`stderr${result.stderrTruncated ? " (truncated)" : ""}:\n${result.stderr}`);
        return parts.join("\n");
      }
      case "sandbox_read_file": {
        const sandbox = await ensure(cfg, botId, turn);
        const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
        const res = await call(key, "GET", `${sbx(sandbox.id)}/files/content?path=${encodeURIComponent(path())}&offset=${offset}&maxBytes=${MAX_READ_BYTES}`, { fetchImpl });
        const text = Buffer.from(await res.arrayBuffer()).toString("utf8");
        const eof = res.headers.get("x-boxcompute-eof");
        const next = res.headers.get("x-boxcompute-next-offset");
        return eof === "false" && next ? `${text}\n[more: call again with offset ${next}]` : text;
      }
      case "sandbox_write_file": {
        const target = path();
        if (target === "/workspace") throw new BoxComputeError("path must name a file under /workspace", 400);
        const bytes = Buffer.from(str("content"), "utf8");
        if (bytes.length > MAX_WRITE_BYTES) throw new BoxComputeError("content is over 8 MiB", 413);
        const sandbox = await ensure(cfg, botId, turn);
        const parent = target.slice(0, target.lastIndexOf("/"));
        if (parent && parent !== "/workspace") {
          await call(key, "POST", `${sbx(sandbox.id)}/files/directory?path=${encodeURIComponent(parent)}`, { body: { recursive: true }, fetchImpl });
        }
        await call(key, "PUT", `${sbx(sandbox.id)}/files/content?path=${encodeURIComponent(target)}`, { raw: bytes, fetchImpl });
        return `wrote ${bytes.length} bytes to ${target}`;
      }
      case "sandbox_list_files": {
        const sandbox = await ensure(cfg, botId, turn);
        const { entries, nextCursor } = await getJson<{ entries: Array<{ name: string; kind: string; size: number }>; nextCursor: string | null }>(
          key,
          "GET",
          `${sbx(sandbox.id)}/files/list?path=${encodeURIComponent(path())}&pageSize=200`,
          { fetchImpl },
        );
        const lines = entries.map((entry) => `${entry.kind === "dir" ? "d" : "-"} ${entry.size}\t${entry.name}`);
        if (nextCursor) lines.push("[more entries not shown]");
        return lines.join("\n") || "(empty)";
      }
      case "sandbox_preview": {
        const port = Math.floor(Number(args.port));
        if (!(port >= 1 && port <= 65535)) throw new BoxComputeError("port must be 1-65535", 400);
        const sandbox = await ensure(cfg, botId, turn);
        const preview = await openPreview(key, sandbox.id, port);
        const note = preview.replaced ? ` The earlier link for port ${preview.replaced} stopped working (one public link per sandbox).` : "";
        return `${preview.url}\nexpires ${preview.expiresAt}. Anyone with this link can open the app until then — share it only with the person you are working for.${note}`;
      }
      case "sandbox_reset": {
        const sandbox = await find(key, botId);
        if (!sandbox) return "No sandbox to delete.";
        await call(key, "DELETE", sbx(sandbox.id), { fetchImpl });
        previews.delete(sandbox.id);
        return `Sandbox deleted with its files. The next sandbox_* command creates a fresh${turn.desktop ? " large" : ""} one.`;
      }
      default:
        throw new BoxComputeError(`unknown sandbox tool ${name}`, 400);
    }
  }

  /** One cloud-desktop call. The first one installs the desktop (about a
   * minute and a half); later ones restart it after a cold wake if needed. */
  async function runDesktopTool(cfg: BoxComputeConfig, botId: string, name: string, args: Record<string, unknown>, turn: SandboxTurn = {}): Promise<SandboxToolResult> {
    const key = token(cfg);
    if (!isDesktopTool(name)) throw new BoxComputeError(`unknown sandbox tool ${name}`, 400);
    if (!turn.desktop) throw new BoxComputeError("the cloud desktop is only available when this conversation works on BoxCompute", 403);
    const action = desktopAction(name, args);
    const sandbox = await ensure(cfg, botId, turn);
    // Sizes are immutable, and a missing size is a historical small VM.
    if (sandbox.size !== "large") {
      throw new BoxComputeError(
        "the cloud desktop needs a large sandbox (1.5 vCPU / 3 GiB) — this bot's sandbox is small, where Chrome gets killed for memory. Rebuilding it as large means sandbox_reset, which deletes everything in /workspace: ask the person first, then call sandbox_reset and try again.",
        409,
      );
    }
    const { result } = await getJson<{
      result: { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; stdoutTruncated: boolean };
    }>(key, "POST", `${sbx(sandbox.id)}/execute`, {
      body: { argv: desktopArgv(action), cwd: "/workspace", timeoutSeconds: DESKTOP_TIMEOUT_SECONDS, maxOutputBytes: 1_048_576 },
      fetchImpl,
    });
    if (result.timedOut) throw new BoxComputeError("the cloud desktop did not answer in time — try again; if it keeps failing, check it with sandbox_exec", 504);
    if (result.exitCode !== 0) {
      const detail = (result.stderr || result.stdout).trim().slice(-1500);
      throw new BoxComputeError(`cloud desktop ${action[0]} failed (exit ${result.exitCode})${detail ? `: ${detail}` : ""}`, 502);
    }
    switch (name) {
      case "sandbox_desktop_screenshot": {
        const newline = result.stdout.indexOf("\n");
        const mimeType = result.stdout.slice(0, newline).trim();
        const data = result.stdout.slice(newline + 1).trim();
        if (result.stdoutTruncated || newline < 0 || !/^image\/(png|jpeg)$/.test(mimeType) || !data) {
          throw new BoxComputeError("the screenshot did not come back whole — try again", 502);
        }
        return { text: `Screenshot of the ${DESKTOP_WIDTH}x${DESKTOP_HEIGHT} cloud desktop. Click coordinates are pixels in this image.`, image: { data, mimeType } };
      }
      case "sandbox_desktop_live_link": {
        const preview = await openPreview(key, sandbox.id, DESKTOP_VNC_PORT);
        const note = preview.replaced ? ` The earlier sandbox_preview link for port ${preview.replaced} stopped working (one public link per sandbox).` : "";
        return {
          text: `${liveLinkUrl(preview.url)}\nexpires ${preview.expiresAt}. Whoever opens it sees and controls this desktop (mouse and keyboard) until then — give it only to the person you are working for. When a site needs a sign-in, a code or a payment, send them this link and let them do it themselves.${note}`,
        };
      }
      case "sandbox_desktop_click":
        return { text: `${args.double === true ? "double-" : ""}clicked ${action[1]},${action[2]}. Take a screenshot to see the result.` };
      case "sandbox_desktop_type":
        return { text: `typed ${action[1].length} characters.` };
      case "sandbox_desktop_key":
        return { text: `pressed ${action.slice(1).join(" ")}.` };
      case "sandbox_desktop_scroll":
        return { text: `scrolled ${args.direction ?? "down"} ${action[4]} at ${action[1]},${action[2]}.` };
      case "sandbox_desktop_open_url":
        return { text: `opened ${action[1]} in a new Chrome tab. Take a screenshot to see it.` };
    }
  }

  /** Wake the bot's existing sandbox ahead of its turn, so the first tool
   * call does not pay the ~30s cold start. Called fire-and-forget when a
   * conversation's place becomes (or opens on) BoxCompute: it never creates
   * a sandbox, never touches an expired one, runs at most once a minute per
   * bot, and never rejects. A cold VM wakes on any execute, so it runs `true`. */
  async function prewarm(cfg: BoxComputeConfig, botId: string): Promise<PrewarmResult> {
    const key = cfg.boxCompute?.token?.trim();
    if (!key) return "unconfigured";
    if (provisioning.has(botId)) return "busy";
    const at = now();
    const last = lastPrewarm.get(botId);
    if (last !== undefined && at - last < PREWARM_DEDUPE_MS) return "deduped";
    lastPrewarm.set(botId, at);
    try {
      const sandbox = await find(key, botId);
      if (!sandbox) return "none";
      if (sandbox.state === "expired") return "expired";
      if (sandbox.state === "running") return "warm";
      if (sandbox.state === "pending") return "starting";
      await call(key, "POST", `${sbx(sandbox.id)}/execute`, {
        body: { argv: ["true"], cwd: "/workspace", timeoutSeconds: 60 },
        fetchImpl,
        timeoutMs: 120_000,
      });
      return "woken";
    } catch {
      return "failed";
    }
  }

  /** Best effort when a bot is deleted, so its sandbox stops billing. */
  async function remove(cfg: { boxCompute?: { token?: string } }, botId: string): Promise<void> {
    const token = cfg.boxCompute?.token?.trim();
    createKeys.delete(botId);
    lastPrewarm.delete(botId);
    if (!token) return;
    const sandbox = await find(token, botId).catch(() => null);
    if (sandbox) await call(token, "DELETE", `/sandboxes/${encodeURIComponent(sandbox.id)}`, { fetchImpl }).catch(() => {});
  }

  return { ensure, find, prewarm, runTool, runDesktopTool, remove };
}

/** BoxCompute only accepts /workspace or below, without . or .. segments.
 * Relative paths are taken from /workspace. */
export function workspacePath(input: string): string {
  const raw = input.trim();
  const absolute = raw.startsWith("/") ? raw : `/workspace/${raw}`;
  const segments = absolute.split("/").filter(Boolean);
  if (segments[0] !== "workspace" || segments.some((segment) => segment === "." || segment === "..")) {
    throw new BoxComputeError("paths must stay under /workspace (no . or .. segments)", 400);
  }
  return `/${segments.join("/")}`;
}

export const SANDBOX_TOOL_NAMES = [
  "sandbox_status",
  "sandbox_exec",
  "sandbox_read_file",
  "sandbox_write_file",
  "sandbox_list_files",
  "sandbox_preview",
  "sandbox_reset",
  ...DESKTOP_TOOL_NAMES,
] as const;
