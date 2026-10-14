import { useEffect, useRef, useSyncExternalStore } from "react";
import { RotateCw } from "lucide-react";

import { terminalSession } from "@/components/workspace/terminal-sessions";
import type { TerminalTarget } from "@/lib/terminal";

/** Shows one terminal tab. The xterm and its shell belong to the session
 * registry; this only lends it a place on screen while the tab is shown. */
export function TerminalTab({ target, tabId, active }: { target: TerminalTarget; tabId: string; active: boolean }) {
  const slotRef = useRef<HTMLDivElement>(null);
  const session = terminalSession(target, tabId);
  const status = useSyncExternalStore(session.subscribe, () => session.status);

  useEffect(() => {
    const slot = slotRef.current;
    if (!slot) return;
    slot.appendChild(session.element);
    session.refit(true);
    if (active) session.focus();
    return () => { if (session.element.parentElement === slot) slot.removeChild(session.element); };
  }, [session, active]);

  const line = status.kind === "ready" ? status.cwd
    : status.kind === "connecting" ? "connecting…"
    : status.kind === "exited" ? `exited with code ${status.code}`
    : status.kind === "closed" ? "disconnected"
    : status.kind === "ended" ? "this shell has ended"
    : status.kind === "elsewhere" ? "open in another window"
    : status.message;
  const stopped = status.kind !== "ready" && status.kind !== "connecting";

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-app" data-testid="terminal-pane">
      <div className="flex h-7 shrink-0 items-center gap-2 px-3 text-[11.5px] text-ink-secondary">
        <span className="min-w-0 flex-1 truncate" title={status.kind === "ready" ? status.cwd : undefined} data-testid="terminal-status">{line}</span>
        {stopped && (
          <button type="button" onClick={() => session.connect(status.kind === "closed" || status.kind === "elsewhere")}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-raised hover:text-ink">
            <RotateCw size={11} />{status.kind === "closed" || status.kind === "elsewhere" ? "reconnect" : "new shell"}
          </button>
        )}
      </div>
      <div ref={slotRef} className="min-h-0 flex-1" />
    </div>
  );
}
