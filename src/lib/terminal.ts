/** Built-in terminal: a local shell in the thread's working folder, shown as
 * a pane beside the conversation. The server owns the shell; the client mints
 * a single-use ticket over HTTP, then speaks JSON frames on a websocket.
 * Contract: release/bos-1.4-terminal-api-contract.md. */

export interface TerminalTarget {
  botId: string;
  threadId: string;
  /** Bot or room name, for the pane label. */
  name: string;
}

export type TerminalClientFrame =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  /** End the shell now instead of leaving it for a reattach. */
  | { type: "close" };

export type TerminalServerFrame =
  | { type: "ready"; cwd: string }
  | { type: "output"; data: string }
  | { type: "exit"; code: number }
  | { type: "error"; error: string };

/** The server rejects anything outside a sane range; clamp before sending. */
export const TERMINAL_MAX_COLS = 500;
export const TERMINAL_MAX_ROWS = 200;

/** The local desktop app only: not a plain browser tab, not a remote client
 * driving this machine. The server checks this again before minting. */
export function terminalAvailable(ogb: { platform?: string; remoteClient?: { active?: boolean } } | undefined = globalThis.window?.ogb): boolean {
  return Boolean(ogb?.platform) && ogb?.remoteClient?.active !== true;
}

export function sameTerminalTarget(a: Pick<TerminalTarget, "botId" | "threadId"> | null | undefined, b: Pick<TerminalTarget, "botId" | "threadId"> | null | undefined): boolean {
  return Boolean(a && b && a.botId === b.botId && a.threadId === b.threadId);
}

export function resizeFrame(cols: number, rows: number): TerminalClientFrame | null {
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) return null;
  const c = Math.min(TERMINAL_MAX_COLS, Math.floor(cols));
  const r = Math.min(TERMINAL_MAX_ROWS, Math.floor(rows));
  return c >= 1 && r >= 1 ? { type: "resize", cols: c, rows: r } : null;
}

/** Parse one server frame; anything malformed is dropped rather than shown. */
export function parseTerminalFrame(raw: unknown): TerminalServerFrame | null {
  if (typeof raw !== "string") return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const frame = value as Record<string, unknown>;
  switch (frame.type) {
    case "ready":
      return typeof frame.cwd === "string" ? { type: "ready", cwd: frame.cwd } : null;
    case "output":
      return typeof frame.data === "string" ? { type: "output", data: frame.data } : null;
    case "exit":
      return typeof frame.code === "number" ? { type: "exit", code: frame.code } : null;
    case "error":
      return typeof frame.error === "string" ? { type: "error", error: frame.error } : null;
    default:
      return null;
  }
}

/** Same host as the page, so the desktop's own api listener; never a bearer
 * in the url, only the 30-second single-use ticket. */
export function terminalSocketUrl(ticket: string, location: Pick<Location, "protocol" | "host"> = globalThis.location): string {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${location.host}/api/terminal?ticket=${encodeURIComponent(ticket)}`;
}

/** `tabId` names a shell that outlives its socket for a while, so the same
 * tab reattaches after a reload or from another window. `resume` only
 * reattaches: the server refuses rather than starting a new shell. */
export async function requestTerminalTicket(target: Pick<TerminalTarget, "botId" | "threadId">, fetcher: typeof fetch = fetch, session?: { tabId: string; resume?: boolean }): Promise<string> {
  const response = await fetcher("/api/terminal/ticket", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ botId: target.botId, threadId: target.threadId, ...(session ? { tabId: session.tabId, ...(session.resume ? { resume: true } : {}) } : {}) }),
  });
  const body = await response.json().catch(() => null) as { ticket?: unknown; error?: unknown } | null;
  if (!response.ok || typeof body?.ticket !== "string" || !body.ticket) {
    throw Object.assign(new Error(typeof body?.error === "string" && body.error ? body.error : `terminal unavailable (${response.status})`), { status: response.status });
  }
  return body.ticket;
}
