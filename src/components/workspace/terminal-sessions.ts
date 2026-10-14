/** Terminal tabs live outside React. Each open terminal tab owns one xterm,
 * one socket and one host element for the whole renderer session; a panel
 * only borrows the element while it shows the tab. Switching threads,
 * moving a tab between panels or remounting the dock therefore never drops
 * a shell, and the server's grace period covers reloads and other windows. */
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

import { parseTerminalFrame, requestTerminalTicket, resizeFrame, terminalSocketUrl, type TerminalClientFrame, type TerminalTarget } from "@/lib/terminal";

export type TerminalStatus =
  | { kind: "connecting" }
  | { kind: "ready"; cwd: string }
  | { kind: "exited"; code: number }
  | { kind: "closed" }
  /** The shell is gone (reaped, or never started in this tab). */
  | { kind: "ended" }
  /** Another window took this shell over. */
  | { kind: "elsewhere" }
  | { kind: "error"; message: string };

function themeColor(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/** Tabs this renderer started a shell for. A tab restored from storage is
 * not in here, so it only reattaches: a reload never spawns a shell. */
const started = new Set<string>();
const sessions = new Map<string, TerminalSession>();

export function markTerminalStarted(tabId: string): void {
  started.add(tabId);
}

export class TerminalSession {
  readonly tabId: string;
  readonly element: HTMLDivElement;
  status: TerminalStatus = { kind: "connecting" };
  private target: TerminalTarget;
  private term: Terminal;
  private fit = new FitAddon();
  private socket: WebSocket | null = null;
  private listeners = new Set<() => void>();
  private observer: ResizeObserver;
  private sentGrid = "";
  private frame = 0;
  private disposed = false;
  private attempt = 0;

  constructor(target: TerminalTarget, tabId: string) {
    this.target = target;
    this.tabId = tabId;
    this.element = document.createElement("div");
    this.element.className = "h-full w-full overflow-hidden px-2 pb-2 pt-1";
    this.element.dataset.testid = "terminal-surface";
    this.term = new Terminal({
      cursorBlink: true,
      fontFamily: '"SF Mono", Menlo, Monaco, Consolas, monospace',
      fontSize: 12.5,
      scrollback: 5000,
      theme: {
        background: themeColor("--color-app", "#070707"),
        foreground: themeColor("--color-ink", "#fcfcfc"),
        cursor: themeColor("--color-ink", "#fcfcfc"),
      },
    });
    this.term.loadAddon(this.fit);
    this.term.open(this.element);
    this.term.onData((data) => this.send({ type: "input", data }));
    // The element's own size covers panel drags, showing a hidden tab and
    // moving between panels; fonts loading late change the cell size.
    this.observer = new ResizeObserver(() => this.schedule());
    this.observer.observe(this.element);
    void document.fonts?.ready.then(() => this.schedule());
    this.connect(!started.has(tabId));
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private report(status: TerminalStatus) {
    if (this.disposed) return;
    this.status = status;
    for (const listener of this.listeners) listener();
  }

  private send(frame: TerminalClientFrame) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(frame));
  }

  private schedule() {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.refit());
  }

  /** Only a real change of grid reaches the pty; a hidden tab has no size. */
  refit(force = false) {
    if (this.disposed || !this.element.isConnected || !this.element.clientWidth || !this.element.clientHeight) return;
    try { this.fit.fit(); } catch { return; }
    const frame = resizeFrame(this.term.cols, this.term.rows);
    if (!frame || frame.type !== "resize" || this.socket?.readyState !== WebSocket.OPEN) return;
    const grid = `${frame.cols}x${frame.rows}`;
    if (!force && grid === this.sentGrid) return;
    this.sentGrid = grid;
    this.send(frame);
  }

  focus() {
    this.term.focus();
  }

  /** resume: reattach only. Otherwise start a shell (or take over the live one). */
  connect(resume: boolean) {
    if (this.disposed) return;
    const attempt = ++this.attempt;
    const previous = this.socket;
    this.socket = null;
    previous?.close();
    if (!resume) started.add(this.tabId);
    this.report({ kind: "connecting" });
    let finished = false;
    void requestTerminalTicket(this.target, fetch, { tabId: this.tabId, resume }).then((ticket) => {
      if (this.disposed || attempt !== this.attempt) return;
      const socket = new WebSocket(terminalSocketUrl(ticket));
      this.socket = socket;
      socket.onopen = () => { this.sentGrid = ""; this.refit(true); };
      socket.onmessage = (event) => {
        if (socket !== this.socket) return;
        const frame = parseTerminalFrame(event.data);
        if (!frame) return;
        if (frame.type === "ready") {
          // a reattach replays the recent screen next; start from a clean slate
          this.term.reset();
          this.report({ kind: "ready", cwd: frame.cwd });
        } else if (frame.type === "output") this.term.write(frame.data);
        else if (frame.type === "exit") {
          finished = true;
          this.term.write(`\r\n\x1b[2m[exited with code ${frame.code}]\x1b[0m\r\n`);
          this.report({ kind: "exited", code: frame.code });
        } else { finished = true; this.report({ kind: "error", message: frame.error }); }
      };
      socket.onclose = (event) => {
        if (socket !== this.socket || finished) return;
        this.report(event.code === 4001 ? { kind: "elsewhere" } : { kind: "closed" });
      };
    }).catch((cause: unknown) => {
      if (attempt !== this.attempt) return;
      if ((cause as { status?: number }).status === 410) this.report({ kind: "ended" });
      else this.report({ kind: "error", message: cause instanceof Error ? cause.message.toLowerCase() : String(cause) });
    });
  }

  /** The tab closed for good: tell the server to end the shell now. */
  close() {
    this.send({ type: "close" });
    this.dispose();
  }

  /** Drop this renderer's hold without ending the shell (the tab moved to
   * another window, which reattaches inside the grace period). */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.observer.disconnect();
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    this.term.dispose();
    this.element.remove();
    this.listeners.clear();
    sessions.delete(this.tabId);
  }
}

export function terminalSession(target: TerminalTarget, tabId: string): TerminalSession {
  let session = sessions.get(tabId);
  if (!session) {
    session = new TerminalSession(target, tabId);
    sessions.set(tabId, session);
  }
  return session;
}

/** End a tab's shell. A tab never shown since the reload has no session
 * here, but its shell may still be waiting out the grace period: reattach
 * just long enough to end it. */
export function closeTerminalSession(tabId: string, target?: TerminalTarget): void {
  const session = sessions.get(tabId);
  if (session) { session.close(); return; }
  started.delete(tabId);
  if (!target) return;
  void requestTerminalTicket(target, fetch, { tabId, resume: true }).then((ticket) => {
    const socket = new WebSocket(terminalSocketUrl(ticket));
    socket.onmessage = () => { socket.send(JSON.stringify({ type: "close" } satisfies TerminalClientFrame)); socket.close(); };
    setTimeout(() => socket.close(), 5000);
  }).catch(() => { /* already gone */ });
}

export function releaseTerminalSession(tabId: string): void {
  sessions.get(tabId)?.dispose();
}
