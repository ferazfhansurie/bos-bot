import { useEffect, useRef, useState } from "react";
import { SUPPORT_EMAIL, appVersion } from "@/lib/app-links";
import { useAppConfig } from "@/lib/app-config";
import { t } from "@/lib/i18n";
import { useV3 } from "@/lib/v3";
import { askBot } from "@/lib/v3-ask";
import { defaultBotId, useOptionalStore } from "@/state/store";
import { ProductFeedback } from "./ProductFeedback";

export function SupportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const config = useAppConfig();
  const close = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const [copied, setCopied] = useState(false);
  const v3 = useV3();
  const store = useOptionalStore();
  // 3.0: the quickest help is the bot that knows this app; email stays below
  const helper = v3 && store ? store.state.bots.find((bot) => bot.id === defaultBotId(store.state.bots)) : undefined;
  const askHelper = () => {
    if (!store || !helper) return;
    onClose();
    askBot(store.dispatch, helper, t("v3.help.prompt"));
  };
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setCopied(false);
    close.current?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key !== "Tab") return;
      const controls = dialog.current?.querySelectorAll<HTMLElement>("button:enabled, input:enabled, textarea:enabled");
      const first = controls?.[0], last = controls?.[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    window.addEventListener("keydown", escape);
    return () => { window.removeEventListener("keydown", escape); previous?.focus(); };
  }, [open, onClose]);
  if (!open) return null;
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={dialog} role="dialog" aria-modal="true" aria-labelledby="bos-support-title" className="max-h-[calc(100dvh-48px)] w-full max-w-md overflow-y-auto rounded-2xl border border-hairline/50 bg-panel p-6 shadow-2xl">
      <h2 id="bos-support-title" className="text-lg font-semibold text-ink">{helper ? t("v3.help.title") : "Contact BOS"}</h2>
      {helper && <>
        <p className="mt-2 text-sm leading-relaxed text-ink-secondary">{t("v3.help.ask", { name: helper.name })}</p>
        <button type="button" data-v3-nod="help" onClick={askHelper} className="mt-3 w-full rounded-xl bg-accent px-4 py-2 text-sm font-medium text-white hover:brightness-110">{t("v3.help.askButton", { name: helper.name })}</button>
        <div className="mt-5 border-t border-hairline/50" />
      </>}
      <p className={helper ? "mt-4 text-sm leading-relaxed text-ink-secondary" : "mt-2 text-sm leading-relaxed text-ink-secondary"}>For help, alpha feedback or a privacy request, email:</p>
      <p className="mt-3 select-text break-all text-sm font-medium text-ink">{SUPPORT_EMAIL}</p>
      <button type="button" className="mt-2 text-sm text-accent hover:underline" onClick={() => void navigator.clipboard.writeText(SUPPORT_EMAIL).then(() => setCopied(true)).catch(() => setCopied(false))}>{copied ? "Copied" : "Copy email address"}</button>
      <p className="mt-4 text-xs leading-relaxed text-ink-secondary">Include BOS {appVersion()}, your device and steps to reproduce. Please leave out passwords, keys and private conversations. Nothing is sent automatically.</p>
      {config.flags.feedback && <div className="mt-5 border-t border-hairline/50 pt-4"><h3 className="text-sm font-semibold text-ink">Tell Firaz</h3><ProductFeedback /></div>}
      <button ref={close} type="button" onClick={onClose} className="mt-5 w-full rounded-xl bg-raised px-4 py-2 text-sm font-medium text-ink">Close</button>
    </section>
  </div>;
}
