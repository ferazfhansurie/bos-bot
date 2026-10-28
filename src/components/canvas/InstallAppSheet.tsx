// What an app from a link asks for, shown before anything is installed. The
// server has already fetched and checked the app and holds it under a token,
// so "add" installs exactly what this sheet describes. v3 only.
import { useEffect, useRef, useState } from "react";
import { Check, Loader2, ShieldCheck, X } from "lucide-react";

import { Glass } from "@/components/Glass";
import { useStore } from "@/state/store";
import type { AppSummary } from "../../../shared/apps";
import { MINI_APP_NEVER, permissionLines } from "../../../shared/mini-apps";
import { appApi, type InstallPreview } from "./app-api";
import { appIcon } from "./app-icons";

export type InstallFrom = { url: string } | { builtin: string };

export function InstallAppSheet({ from, botId: initialBot, onClose, onInstalled }: {
  from: InstallFrom;
  /** the bot that runs it unless the owner picks another */
  botId: string;
  onClose: () => void;
  onInstalled: (app: AppSummary) => void;
}) {
  const { state } = useStore();
  const bots = state.bots.filter(b => !b.hidden && !b.homeLink);
  const [held, setHeld] = useState<{ token: string; preview: InstallPreview } | null>(null);
  const [error, setError] = useState("");
  const [botId, setBotId] = useState(initialBot);
  const [adding, setAdding] = useState(false);
  const dialog = useRef<HTMLElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const key = "url" in from ? `url:${from.url}` : `builtin:${from.builtin}`;

  useEffect(() => {
    let live = true;
    setHeld(null); setError("");
    appApi.previewInstall(from).then(r => { if (live) setHeld(r); }, (e: unknown) => { if (live) setError(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  // from is a fresh object each render; key is what it says
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancel.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
      if (event.key !== "Tab") return;
      const controls = dialog.current?.querySelectorAll<HTMLElement>("button:enabled, select:enabled");
      const first = controls?.[0], last = controls?.[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); previous?.focus(); };
  }, [onClose]);

  const add = async () => {
    if (!held) return;
    setAdding(true); setError("");
    try {
      const { app } = await appApi.install(held.token, botId);
      onInstalled(app);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setAdding(false);
    }
  };

  const preview = held?.preview;
  const manifest = preview?.manifest;
  const botName = bots.find(b => b.id === botId)?.name ?? "your bot";
  const existing = preview?.existing[botId];
  const Icon = appIcon(manifest?.icon);
  const by = [manifest && `v${manifest.version}`, preview && (preview.builtin ? "made by bos bot" : preview.host), manifest?.author && !preview?.builtin && `by ${manifest.author}`].filter(Boolean).join(" · ");

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-3 sm:items-center sm:p-6" data-testid="install-app-sheet"
      onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <Glass as="section" ref={dialog} role="dialog" aria-modal="true" aria-labelledby="install-app-title" aria-busy={!held && !error} radius={24} fallback="solid"
        className="flex max-h-[calc(100dvh-24px)] w-full max-w-[420px] flex-col gap-5 overflow-y-auto rounded-[24px] border border-hairline/50 bg-panel p-6 shadow-2xl">
        <div className="flex items-start gap-3.5">
          <span className="flex size-12 shrink-0 items-center justify-center rounded-[14px] bg-ink/[.06] text-ink/80"><Icon size={24} strokeWidth={1.7} /></span>
          <div className="min-w-0 flex-1">
            <h2 id="install-app-title" className="truncate text-[17px] font-semibold text-ink">{manifest?.name ?? (error ? "can't add this app" : "checking the app…")}</h2>
            <p className="truncate text-[13px] text-ink/55">{by || ("url" in from ? from.url : "bos bot")}</p>
          </div>
          <button type="button" aria-label="Close" onClick={onClose} className="-me-2 -mt-2 flex size-8 shrink-0 items-center justify-center rounded-full text-ink/50 hover:bg-ink/[.06] hover:text-ink"><X size={16} /></button>
        </div>

        {!preview && !error && <p className="flex items-center gap-2 text-[14px] text-ink/60"><Loader2 size={15} className="animate-spin motion-reduce:animate-none" />fetching it and checking what it asks for</p>}

        {manifest?.description && <p className="text-[14px] leading-relaxed text-ink/80">{manifest.description}</p>}

        {manifest && (
          <div className="flex flex-col gap-2.5" data-testid="install-app-permissions">
            <p className="text-[12px] font-medium uppercase tracking-[0.06em] text-ink/45">it can</p>
            {permissionLines(manifest, botName).map(line => (
              <div key={line.key} className="flex gap-2.5">
                <Check size={16} strokeWidth={2.2} className="mt-0.5 shrink-0 text-ink/70" />
                <div><p className="text-[14px] text-ink">{line.text}</p><p className="text-[12.5px] text-ink/55">{line.detail}</p></div>
              </div>
            ))}
            <div className="flex gap-2.5">
              <ShieldCheck size={16} strokeWidth={2} className="mt-0.5 shrink-0 text-ink/70" />
              <p className="text-[14px] text-ink/75">{MINI_APP_NEVER}</p>
            </div>
          </div>
        )}

        {manifest && (
          <label className="flex items-center justify-between gap-3 rounded-[14px] bg-ink/[.04] px-3.5 py-2.5 text-[14px] text-ink">
            <span className="text-ink/60">runs with</span>
            <select value={botId} onChange={e => setBotId(e.target.value)} data-testid="install-app-bot"
              className="min-w-0 max-w-[60%] truncate bg-transparent text-end font-medium text-ink outline-none">
              {bots.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </label>
        )}

        {existing && manifest && (
          <p className="text-[13px] text-ink/60" data-testid="install-app-update">
            {existing.version === manifest.version ? `${botName} already has v${existing.version}. adding it again keeps its data.` : `updates v${existing.version} to v${manifest.version}. keeps its data.`}
          </p>
        )}

        {error && <p role="alert" className="text-[13.5px] text-danger">{error}</p>}

        <div className="flex justify-end gap-2">
          <button ref={cancel} type="button" onClick={onClose} className="h-10 rounded-full px-4 text-[14px] text-ink/70 hover:bg-ink/[.06] hover:text-ink">cancel</button>
          <button type="button" onClick={() => void add()} disabled={!held || adding || !bots.some(b => b.id === botId)} data-testid="install-app-add"
            className="inline-flex h-10 items-center gap-2 rounded-full bg-ink px-5 text-[14px] font-medium text-app transition-opacity disabled:opacity-30">
            {adding && <Loader2 size={14} className="animate-spin motion-reduce:animate-none" />}{existing ? "update" : "add app"}
          </button>
        </div>
      </Glass>
    </div>
  );
}
