import { useLayoutEffect, useRef, useState } from "react";
import { AppWindow, Loader2, Monitor, ShieldAlert, X } from "lucide-react";

import { cn } from "@/lib/cn";
import { isMacPlatform } from "@/lib/keyboard-shortcuts";
import { APPSHOT_SHORTCUT, attachAppshot, closeAppshotPicker, moveSelection, openAppshotPicker, shortcutKeys, type AppshotOpen } from "@/lib/appshot";

const COLUMNS = 3;

/**
 * The appshot picker: open app windows (thumbnail, app icon, title) plus the
 * whole screen. The first window is the one that was in front when the
 * shortcut was pressed, so Enter attaches it straight away.
 */
export function AppshotPicker({ listing }: { listing: AppshotOpen }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [selected, setSelected] = useState(listing.rows.length ? 0 : -1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const isMac = isMacPlatform();
  const windows = listing.rows.filter((row) => row.kind === "window");
  const screens = listing.rows.filter((row) => row.kind === "screen");
  const ordered = [...windows, ...screens];

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    dialog.focus();
    return () => dialog.close();
  }, []);

  const pick = async (index: number) => {
    const row = ordered[index];
    if (!row || busy) return;
    setBusy(true);
    setError("");
    try {
      await attachAppshot(row.id);
      closeAppshotPicker();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : "Could not capture that window.");
      setBusy(false);
    }
  };

  const card = (row: AppshotRow, index: number) => (
    <button
      key={row.id}
      type="button"
      data-appshot-card
      aria-pressed={selected === index}
      onMouseEnter={() => setSelected(index)}
      onFocus={() => setSelected(index)}
      onClick={() => void pick(index)}
      disabled={busy}
      className={cn(
        "group flex min-w-0 flex-col gap-2 rounded-xl border p-2 text-left transition-colors",
        selected === index ? "border-accent/70 bg-accent/10" : "border-hairline/40 bg-raised hover:border-hairline",
      )}
    >
      <span className="flex aspect-[16/10] w-full items-center justify-center overflow-hidden rounded-lg bg-inset">
        <img src={row.thumbnail} alt="" className="max-h-full max-w-full object-contain" draggable={false} />
      </span>
      <span className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-ink">
        {row.icon
          ? <img src={row.icon} alt="" className="size-4 shrink-0" draggable={false} />
          : row.kind === "screen" ? <Monitor size={14} className="shrink-0 text-ink-secondary" /> : <AppWindow size={14} className="shrink-0 text-ink-secondary" />}
        <span className="truncate">{row.title}</span>
      </span>
    </button>
  );

  const keys = listing.shortcut ? shortcutKeys(listing.shortcut, isMac) : [];

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="appshot-title"
      className="m-auto w-[min(720px,calc(100%-32px))] max-h-[85vh] overflow-hidden rounded-2xl border border-hairline/50 bg-panel p-0 text-ink shadow-2xl outline-none backdrop:bg-black/60 backdrop:backdrop-blur-xs"
      onCancel={(event) => { event.preventDefault(); if (!busy) closeAppshotPicker(); }}
      onMouseDown={(event) => event.target === event.currentTarget && !busy && closeAppshotPicker()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter" && selected >= 0) { event.preventDefault(); void pick(selected); return; }
        if (event.key.startsWith("Arrow")) {
          event.preventDefault();
          const next = moveSelection(selected, event.key, ordered.length, COLUMNS);
          setSelected(next);
          dialogRef.current?.querySelectorAll<HTMLButtonElement>("[data-appshot-card]")[next]?.focus();
        }
      }}
    >
      <div className="flex max-h-[85vh] flex-col">
        <div className="flex items-center justify-between border-b border-hairline/40 px-5 py-3.5">
          <div>
            <h2 id="appshot-title" className="text-[15px] font-semibold text-ink">Attach an appshot</h2>
            <p className="text-[12px] text-ink-secondary">
              Pick a window to attach a screenshot of it.
              {keys.length > 0 && <> Shortcut {keys.map((key, i) => <kbd key={i} className="mx-px rounded border border-hairline/60 bg-control px-1 font-mono text-[11px]">{key}</kbd>)} works from any app.</>}
            </p>
          </div>
          <button type="button" onClick={closeAppshotPicker} disabled={busy} aria-label="Close" className="rounded-lg p-1.5 text-ink-secondary hover:bg-raised hover:text-ink">
            <X size={18} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {listing.permission !== "ok" ? (
            <div className="flex flex-col items-start gap-3 rounded-xl border border-hairline/40 bg-raised p-4">
              <div className="flex items-center gap-2 text-[13.5px] font-medium"><ShieldAlert size={16} className="text-accent" />Screen Recording is off for BOS Bot</div>
              <p className="text-[12.5px] leading-relaxed text-ink-secondary">
                {listing.permission === "needs-relaunch"
                  ? "If you just turned it on, macOS applies it after BOS Bot quits and reopens. Quit BOS Bot when no bot is working, open it again, then take the appshot."
                  : "Appshots use the same Screen Recording permission as computer use. Turn on BOS Bot under Privacy & Security › Screen & System Audio Recording, then quit and reopen BOS Bot."}
              </p>
              <button
                type="button"
                onClick={() => { void window.ogb?.appshot?.openSettings().then(() => closeAppshotPicker()); }}
                className="rounded-full bg-accent px-3.5 py-1.5 text-[12.5px] font-medium text-accent-ink hover:opacity-90"
              >
                Open Screen Recording settings
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              {windows.length > 0 ? (
                <div className="grid grid-cols-3 gap-3">{windows.map((row, i) => card(row, i))}</div>
              ) : (
                <p className="text-[12.5px] text-ink-secondary">No other app windows are open.</p>
              )}
              {screens.length > 0 && (
                <div>
                  <h3 className="mb-2 text-[12px] font-medium text-ink-secondary">Entire screen</h3>
                  <div className="grid grid-cols-3 gap-3">{screens.map((row, i) => card(row, windows.length + i))}</div>
                </div>
              )}
            </div>
          )}
          {error && <p role="alert" className="mt-3 text-[12.5px] text-danger">{error}</p>}
        </div>
        {busy && (
          <div className="flex items-center gap-2 border-t border-hairline/40 px-5 py-2.5 text-[12px] text-ink-secondary">
            <Loader2 size={14} className="animate-spin" /> Capturing…
          </div>
        )}
      </div>
    </dialog>
  );
}

/**
 * The "Appshot a window" row in the composer's "+" menu, beside "Attach
 * files". Only rendered in the local desktop app (appshotsAvailable()).
 */
export function AppshotMenuItem({ onError }: { onError: (message: string) => void }) {
  const isMac = isMacPlatform();
  return (
    <button
      type="button"
      onClick={(event) => {
        const menu = event.currentTarget.closest("details");
        if (menu) menu.open = false;
        openAppshotPicker().catch((cause) => onError(cause instanceof Error ? cause.message : "Could not list windows."));
      }}
      aria-label="Appshot a window"
      title="Attach a screenshot of another app's window"
      className="flex size-8 shrink-0 items-center justify-center rounded-full text-ink-secondary hover:bg-control hover:text-ink"
    >
      <AppWindow size={17} /><span>Appshot a window</span>
      <span className="ml-auto font-mono text-[11px] text-ink-secondary">{shortcutKeys(APPSHOT_SHORTCUT, isMac).join(isMac ? "" : "+")}</span>
    </button>
  );
}
