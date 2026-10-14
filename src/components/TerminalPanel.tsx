import { useEffect, useRef, useState } from "react";
import { FolderTree, PanelRight, PanelRightClose, RotateCw, SquareTerminal, X } from "lucide-react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

import { useWorkspace } from "@/components/workspace/WorkspaceContext";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { PanelSizeSpec } from "@/lib/panel-resize";
import { bottomVisible, rightVisible, type WorkspaceTabKind } from "@/lib/thread-workspace";
import { runWorkspaceCommand, type WorkspaceCommandId } from "@/lib/workspace-commands";
import { parseTerminalFrame, requestTerminalTicket, resizeFrame, sameTerminalTarget, terminalAvailable, terminalSocketUrl, type TerminalClientFrame, type TerminalTarget } from "@/lib/terminal";

/** Width of the terminal beside the chat; the chat keeps at least 360px. */
export const TERMINAL_PANEL_SIZE: PanelSizeSpec = { key: "bos.terminalPanelWidth", defaultSize: 520, min: 300, reserve: 360 };

type Status =
  | { kind: "connecting" }
  | { kind: "ready"; cwd: string }
  | { kind: "exited"; code: number }
  | { kind: "closed" }
  | { kind: "error"; message: string };

function themeColor(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/** One live shell. Remounting (a new `key`) is the only way to get another:
 * the server never keeps a detached shell, so restart = fresh ticket. */
function TerminalSurface({ target, onStatus }: { target: TerminalTarget; onStatus: (status: Status) => void }) {
  const { botId, threadId } = target;
  const hostRef = useRef<HTMLDivElement>(null);
  const statusRef = useRef(onStatus);
  statusRef.current = onStatus;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let socket: WebSocket | null = null;
    let finished = false;
    const report = (status: Status) => { if (!disposed) statusRef.current(status); };
    const send = (frame: TerminalClientFrame) => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame)); };

    const term = new Terminal({
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
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    // Only a real change of grid reaches the pty: a drag fires many
    // observer callbacks, most of which land on the same cols × rows.
    let sent = "";
    const refit = (force = false) => {
      // A hidden tab or collapsed panel has no size; refit again once shown.
      if (disposed || !host.clientWidth || !host.clientHeight) return;
      try { fit.fit(); } catch { return; }
      const frame = resizeFrame(term.cols, term.rows);
      if (!frame || frame.type !== "resize" || socket?.readyState !== WebSocket.OPEN) return;
      const grid = `${frame.cols}x${frame.rows}`;
      if (!force && grid === sent) return;
      sent = grid;
      send(frame);
    };
    refit();
    let frameId = 0;
    const schedule = () => {
      cancelAnimationFrame(frameId);
      frameId = requestAnimationFrame(() => refit());
    };
    // The host's own size covers panel drags, showing a hidden tab and most
    // window resizes; the window listener catches a maximize that changes
    // nothing but the device pixel ratio, and font load changes cell size.
    const observer = new ResizeObserver(schedule);
    observer.observe(host);
    window.addEventListener("resize", schedule);
    void document.fonts?.ready.then(schedule);
    const input = term.onData((data) => send({ type: "input", data }));

    report({ kind: "connecting" });
    void requestTerminalTicket({ botId, threadId }).then((ticket) => {
      if (disposed) return;
      socket = new WebSocket(terminalSocketUrl(ticket));
      socket.onopen = () => { refit(true); term.focus(); };
      socket.onmessage = (event) => {
        const frame = parseTerminalFrame(event.data);
        if (!frame) return;
        if (frame.type === "ready") report({ kind: "ready", cwd: frame.cwd });
        else if (frame.type === "output") term.write(frame.data);
        else if (frame.type === "exit") { finished = true; term.write(`\r\n\x1b[2m[${t("terminal.exited", { code: String(frame.code) })}]\x1b[0m\r\n`); report({ kind: "exited", code: frame.code }); }
        else { finished = true; report({ kind: "error", message: frame.error }); }
      };
      socket.onclose = () => { if (!finished) report({ kind: "closed" }); };
    }).catch((cause: unknown) => report({ kind: "error", message: cause instanceof Error ? cause.message : String(cause) }));

    return () => {
      disposed = true;
      cancelAnimationFrame(frameId);
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      input.dispose();
      // closing the socket is what kills the pty on the server
      socket?.close();
      term.dispose();
    };
  }, [botId, threadId]);

  return <div ref={hostRef} data-testid="terminal-surface" className="min-h-0 flex-1 overflow-hidden px-2 pb-2" />;
}

/** Terminal pane for the split workspace, opened from a thread header. */
export function TerminalPanel({ target, onClose }: { target: TerminalTarget; onClose: () => void }) {
  const [session, setSession] = useState(0);
  const [status, setStatus] = useState<Status>({ kind: "connecting" });
  const ended = status.kind === "exited" || status.kind === "closed" || status.kind === "error";

  return (
    <section aria-label={t("terminal.pane", { name: target.name })} data-testid="terminal-pane" className="flex h-full min-w-0 flex-1 flex-col border-l border-hairline/50 bg-app">
      <header className="flex h-12 shrink-0 items-center gap-2 px-3 text-[13px]">
        <SquareTerminal size={15} className="shrink-0 text-ink-secondary" />
        <span className="shrink-0 font-semibold text-ink">{t("terminal.title")}</span>
        <span className="min-w-0 flex-1 truncate text-ink-secondary" title={status.kind === "ready" ? status.cwd : undefined} data-testid="terminal-status">
          {status.kind === "ready" ? status.cwd
            : status.kind === "connecting" ? t("terminal.connecting")
            : status.kind === "exited" ? t("terminal.exited", { code: String(status.code) })
            : status.kind === "closed" ? t("terminal.disconnected")
            : status.message}
        </span>
        {ended && (
          <button type="button" onClick={() => setSession((n) => n + 1)} title={t("terminal.restart")} aria-label={t("terminal.restart")}
            className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"><RotateCw size={14} /></button>
        )}
        <button type="button" onClick={onClose} title={t("terminal.close")} aria-label={t("terminal.close")}
          className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"><X size={14} /></button>
      </header>
      <TerminalSurface key={`${target.botId}:${target.threadId}:${session}`} target={target} onStatus={setStatus} />
    </section>
  );
}

/** Thread header buttons for the workspace beside the chat: terminal, files
 * and the panel itself. Only the desktop owner gets them: hidden in the
 * browser and for remote clients, and the server enforces the same. */
export function TerminalButton({ target, className }: { target: TerminalTarget; className?: string }) {
  const workspace = useWorkspace();
  if (!terminalAvailable()) return null;
  const here = sameTerminalTarget(workspace.target, target);
  const state = workspace.workspace;
  const showing = (kind: WorkspaceTabKind) => here && state.tabs.some((tab) => tab.kind === kind
    && state.active[tab.pane] === tab.id && (tab.pane === "right" ? rightVisible(state) : bottomVisible(state)));
  const panelOpen = here && rightVisible(state);
  const press = (command: WorkspaceCommandId, kind: WorkspaceTabKind | null) => {
    if (here) { runWorkspaceCommand(command); return; }
    workspace.show(target);
    workspace.openTab(kind ?? (workspace.browserAvailable ? "browser" : "files"));
  };
  const button = (open: boolean) => cn("p-1.5 hover:bg-raised max-md:hidden", open ? "text-accent" : "text-ink-secondary hover:text-ink", className);
  return (
    <>
      <button type="button" onClick={() => press("workspace-terminal", "terminal")} aria-label="terminal" aria-pressed={showing("terminal")} title="terminal" data-testid="terminal-toggle"
        className={button(showing("terminal"))}><SquareTerminal size={18} /></button>
      <button type="button" onClick={() => press("workspace-files", "files")} aria-label="files" aria-pressed={showing("files")} title="files"
        className={button(showing("files"))}><FolderTree size={18} /></button>
      <button type="button" onClick={() => press("workspace-layout", null)} aria-label="side panel" aria-pressed={panelOpen} title="side panel"
        className={button(panelOpen)}>{panelOpen ? <PanelRightClose size={18} /> : <PanelRight size={18} />}</button>
    </>
  );
}
