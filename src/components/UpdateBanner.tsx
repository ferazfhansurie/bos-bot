// Quiet update chip, required-update screen, and actionable failure card.
// The preload bridge is absent in browser/dev sessions.
import { useEffect, useRef, useState } from "react";
import { ArrowDownToLine, Loader2, PackageOpen, RefreshCw, Sparkles, X } from "lucide-react";
import { useUpdaterState, type UpdaterState } from "@/lib/updater";
import { cn } from "@/lib/cn";
import { brand } from "../lib/brand";

// The one action button in the card. Disabled drops the accent fill for the
// flat raised grey — the "I heard you" the click needs while the main process
// gets going.
const primaryAction =
  "flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-accent py-1.5 text-[13px] font-medium text-white transition-colors disabled:cursor-default disabled:bg-control disabled:text-ink-secondary";

// electron-updater surfaces failures as a whole HTTP dump — status line,
// every response header, stack trace. That is unreadable in a 300px popup,
// so name common failures and keep everything else plain.
function friendlyError(message?: string): string {
  if (!message) return "Something went wrong.";
  if (/cannot find .*\.yml|404/i.test(message))
    return "No update has been published for this platform yet.";
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|net::/i.test(message))
    return "Couldn't reach the update server.";
  return message.split("\n")[0].slice(0, 140);
}

const INSTALLER_URL = "https://bosbot.my/get";

// A remote minimum blocks the app only while a qualifying update is actually
// on its way. Config alone, an empty or lagging feed, a failed check or
// download, a held contract and terminal hand-offs all fall back to a
// dismissible card: raising the floor early must never lock anyone out.
export function requiredUpdateBlocks(s: UpdaterState): boolean {
  if (!s.required || s.installMode === "handoff") return false;
  if (s.status === "installing") return !s.message;
  return ["available", "downloading", "preparing", "downloaded"].includes(s.status);
}

function RequiredUpdate({ state: s }: { state: UpdaterState }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
    return () => dialog.current?.close();
  }, []);
  return (
    <dialog ref={dialog} onCancel={event => event.preventDefault()} aria-label="Updating BOS"
      className="fixed inset-0 m-0 flex h-screen max-h-none w-screen max-w-none items-center justify-center border-0 bg-panel p-0 text-ink">
      <div className="max-w-sm space-y-4 p-8 text-center">
        <Loader2 className="mx-auto animate-spin text-accent" size={28} />
        <h1 className="text-lg font-semibold">Updating bos</h1>
        <p className="text-sm text-ink-secondary">
          {s.status === "installing" ? "Restarting to finish the update…"
            : `Getting version ${s.minimumVersion} or newer…${s.percent == null ? "" : ` ${Math.round(s.percent)}%`}`}
        </p>
      </div>
    </dialog>
  );
}

export function UpdateBanner() {
  const s = useUpdaterState();
  // dismissal is per status+version, so the popup returns for the next
  // update (and when an available one finishes downloading)
  const [dismissed, setDismissed] = useState<string | null>(null);
  // A click has to go renderer → main → broadcast before the real status
  // arrives. Latch the pressed button as busy on the same frame so it greys
  // out immediately; the incoming status clears the latch.
  const [pending, setPending] = useState<"download" | "install" | "check" | null>(null);
  const status = s?.status;
  useEffect(() => setPending(null), [status]);

  if (!s) return null;
  const updater = window.ogb!.updater!;
  if (requiredUpdateBlocks(s)) return <RequiredUpdate state={s} />;
  // Below the floor with nothing qualifying on the feed: say so, dismissibly.
  const requiredIdle = s.required === true && s.status === "idle";
  const key = `${s.status}:${s.version ?? ""}`;
  if (dismissed === key) return null;
  // Native updates stay out of the way until they are ready or need help.
  if (!requiredIdle && s.automaticUpdates && s.installMode !== "handoff" && ["idle", "checking", "available", "downloading", "preparing"].includes(s.status)) return null;
  if (!requiredIdle && (s.status === "idle" || s.status === "checking")) return null;

  if (s.automaticUpdates && s.status === "downloaded" && s.installMode !== "handoff") {
    return (
      <button className="fixed bottom-4 left-4 z-50 flex items-center gap-2 rounded-full border border-hairline/40 bg-panel px-3 py-2 text-xs text-ink-secondary shadow-lg hover:text-ink disabled:opacity-50"
        disabled={pending !== null} onClick={() => { setPending("install"); void updater.install(); }}>
        <RefreshCw size={12} /> Restart to finish
      </button>
    );
  }

  // while busy the card owns the moment: no dismissing, no second click
  const installing = s.status === "installing";
  const preparing = s.status === "preparing";
  const busy = s.status === "downloading" || preparing || installing;
  // Ubuntu system packages can't be swapped under a running app, so the
  // command is copied and a terminal opens; the user finishes there.
  // Nothing restarts, and the card has to stop promising that it will.
  const handoff = s.installMode === "handoff";

  const title = requiredIdle
    ? "Update required"
    : s.status === "available"
      ? `${brand().name} ${s.version} is available`
      : s.status === "downloading"
        ? `Downloading ${s.version ?? "update"}…`
        : preparing
          ? "Preparing update…"
          : s.status === "downloaded"
            ? `${s.version} is ready`
            : installing
              ? handoff
                ? "Opening a terminal…"
                : "Restarting to update…"
              : s.status === "handed-off"
                ? "Finish in a terminal"
                : "Update failed";
  const subtitle = requiredIdle
    ? `This version is no longer supported. Get ${s.minimumVersion ?? "the latest version"} or newer.`
    : s.status === "available"
      ? "A newer version is ready to download."
      : s.status === "downloading"
        ? // no percent yet means the transfer hasn't reported in — don't imply 0
          s.percent == null
          ? "Starting download…"
          : `${Math.round(s.percent)}%`
        : preparing
          ? "Download complete. macOS is preparing the update."
          : s.status === "downloaded"
            ? handoff
              ? "Copy the install command and open a terminal."
              : "Restart to finish updating."
            : installing
              ? handoff
                ? "Copying the command…"
                : s.message || `${brand().name} will reopen in a moment.`
              : s.status === "handed-off"
                ? s.terminalOpened
                  ? "Command copied — paste it in the terminal that opened."
                  : "Command copied — paste it in a terminal to finish."
                : s.quitHeld
                  ? `${brand().name} quits as soon as active tasks finish.`
                  : s.retryable === false
                  ? `${friendlyError(s.message?.split(" Quit and reopen ")[0])} Quit and reopen ${brand().name} before trying the update again.`
                  : friendlyError(s.message);

  return (
    <div className="animate-panel-in fixed bottom-4 left-4 z-50 w-[300px] rounded-xl border border-hairline/40 bg-panel p-3.5 shadow-2xl shadow-black/50">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent">
          <Sparkles size={14} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-semibold text-ink">{title}</div>
          <div className="mt-0.5 text-[12.5px] text-ink-secondary" title={subtitle}>
            {subtitle}
          </div>
        </div>
        {!busy && (
          <button
            onClick={() => setDismissed(key)}
            className="shrink-0 rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink"
            title="Dismiss"
          >
            <X size={14} />
          </button>
        )}
      </div>

      {s.required && !busy && (
        <a className="mt-2 block text-[12.5px] text-accent underline" href={INSTALLER_URL} target="_blank" rel="noreferrer">
          Download the latest installer
        </a>
      )}

      {s.status === "handed-off" && s.command && (
        <code className="mt-2.5 block overflow-x-auto rounded-lg bg-control px-2 py-1.5 font-mono text-[11.5px] whitespace-pre text-ink-secondary">
          {s.command}
        </code>
      )}

      {s.status === "downloading" && (
        <div className="mt-2.5 h-1 overflow-hidden rounded-full bg-control">
          <div
            className={cn(
              "h-full rounded-full bg-accent transition-[width]",
              // before the first progress report, a sliver that breathes beats
              // a zero-width bar that looks stalled
              s.percent == null && "w-1/4 animate-pulse",
            )}
            style={s.percent == null ? undefined : { width: `${Math.min(100, Math.max(0, s.percent))}%` }}
          />
        </div>
      )}

      {(preparing || installing) && (
        <div className="mt-2.5 flex gap-2">
          <button
            disabled
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-control py-1.5 text-[13px] font-medium text-ink-secondary"
          >
            <Loader2 size={13} className="animate-spin" /> {preparing ? "Preparing…" : handoff ? "Opening…" : "Restarting…"}
          </button>
        </div>
      )}

      {!busy && (
        <div className="mt-2.5 flex gap-2">
          {s.status === "available" && (
            <button
              onClick={() => {
                setPending("download");
                void updater.download();
              }}
              disabled={pending !== null}
              className={primaryAction}
            >
              {pending === "download" ? (
                <>
                  <Loader2 size={13} className="animate-spin" /> Starting…
                </>
              ) : (
                <>
                  <ArrowDownToLine size={13} /> Download
                </>
              )}
            </button>
          )}
          {s.status === "downloaded" && (
            <button
              onClick={() => {
                setPending("install");
                void updater.install();
              }}
              disabled={pending !== null}
              className={primaryAction}
            >
              {pending === "install" ? (
                <>
                  <Loader2 size={13} className="animate-spin" /> {handoff ? "Opening…" : "Restarting…"}
                </>
              ) : handoff ? (
                <>
                  <PackageOpen size={13} /> Install
                </>
              ) : (
                <>
                  <RefreshCw size={13} /> Restart to update
                </>
              )}
            </button>
          )}
          {s.status === "error" && s.quitHeld && (
            <button
              onClick={() => void updater.quitNow?.()}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-control py-1.5 text-[13px] text-ink hover:bg-raised-hover"
            >
              Quit without waiting
            </button>
          )}
          {(requiredIdle || (s.status === "error" && s.retryable !== false)) && (
            <button
              onClick={() => {
                setPending("check");
                void updater.check();
              }}
              disabled={pending !== null}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-control py-1.5 text-[13px] text-ink hover:bg-raised-hover disabled:text-ink-secondary disabled:hover:bg-control"
            >
              {pending === "check" ? (
                <>
                  <Loader2 size={13} className="animate-spin" /> Checking…
                </>
              ) : (
                "Try again"
              )}
            </button>
          )}
          <button
            onClick={() => setDismissed(key)}
            disabled={pending !== null}
            className="rounded-lg px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-50 disabled:hover:bg-transparent"
          >
            {/* after a hand-off there is nothing left to postpone */}
            {s.status === "handed-off" || s.retryable === false ? "Dismiss" : "Later"}
          </button>
        </div>
      )}
    </div>
  );
}
