// The update, Grok-style: a round button at the end of the sidebar footer
// that only exists when there is something to install, and a "New update
// available · Install" banner at the top of the profile menu. One press
// installs. BOS server builds (lib/bos-update) wait for running bots to
// finish before restarting; the desktop shell's own updater downloads, then
// restarts. Progress and history stay in Settings → Updates.
import { CloudDownload, Loader2 } from "lucide-react";
import { applyUpdate, availableCandidate, isUpdateRunning, shortVersion, stepLabel, useBosUpdate } from "@/lib/bos-update";
import { useUpdaterState } from "@/lib/updater";
import { useStore } from "@/state/store";
import { cn } from "@/lib/cn";

export interface SidebarUpdate {
  running: boolean;
  /** "1.9.8", or "" when only the build differs */
  version: string;
  label: string;
  install: () => void;
}

export function useSidebarUpdate(): SidebarUpdate | null {
  const view = useBosUpdate();
  const shell = useUpdaterState();
  const updater = typeof window === "undefined" ? undefined : window.ogb?.updater;

  const bosRunning = isUpdateRunning(view.state) || view.pending !== null;
  const candidate = availableCandidate(view.status);
  if (bosRunning || (view.state === "ready" && candidate)) {
    const version = shortVersion(candidate?.version);
    const step = stepLabel(view.pending && !isUpdateRunning(view.state) ? "building" : view.state);
    return {
      running: bosRunning,
      version,
      label: bosRunning ? `Updating · ${step}` : version ? `Install BOS ${version}` : "Install update",
      install: () => void applyUpdate(false),
    };
  }

  const status = shell?.status;
  if (updater && (status === "available" || status === "downloaded" || status === "downloading" || status === "preparing" || status === "installing")) {
    const running = status === "downloading" || status === "preparing" || status === "installing";
    const version = shell?.version ?? "";
    return {
      running,
      version,
      label: running
        ? status === "downloading" && shell?.percent != null ? `Downloading ${Math.round(shell.percent)}%` : "Updating…"
        : version ? `Install ${version}` : "Install update",
      install: () => void (status === "downloaded" ? updater.install() : updater.download()),
    };
  }
  return null;
}

/** The round button at the end of the footer. While a run is going it spins
 * and opens Settings → Updates instead of starting another. */
export function SidebarUpdateButton({ update }: { update: SidebarUpdate }) {
  const { dispatch } = useStore();
  return (
    <button
      type="button"
      onClick={() => (update.running ? dispatch({ type: "toggleAppSettings", open: true, section: "updates" }) : update.install())}
      aria-label={update.label}
      title={update.label}
      data-testid="sidebar-update"
      className={cn(
        "animate-pop-in flex size-10 shrink-0 items-center justify-center rounded-full transition-[transform,background-color] active:scale-95",
        update.running ? "bg-raised text-ink-secondary" : "bg-ink text-app hover:bg-ink/90",
      )}
    >
      {update.running ? <Loader2 size={18} className="animate-spin" /> : <CloudDownload size={19} strokeWidth={2} />}
    </button>
  );
}

/** Top of the profile menu. */
export function UpdateMenuBanner({ update, onDone }: { update: SidebarUpdate; onDone?: () => void }) {
  const { dispatch } = useStore();
  return (
    <div className="px-1.5 pb-1.5 pt-0.5">
      <div className="flex items-center gap-3 rounded-xl bg-accent/15 py-2 pl-3 pr-2">
        <span className="min-w-0 flex-1 truncate text-[14px] text-accent">
          {update.running ? update.label : "New update available"}
        </span>
        <button
          type="button"
          onClick={() => {
            if (update.running) dispatch({ type: "toggleAppSettings", open: true, section: "updates" });
            else update.install();
            onDone?.();
          }}
          className="h-8 shrink-0 rounded-full bg-ink px-3.5 text-[13px] font-medium text-app transition-colors hover:bg-ink/90"
        >
          {update.running ? "View" : "Install"}
        </button>
      </div>
    </div>
  );
}
