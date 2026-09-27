import { useEffect, useRef, useState } from "react";
import { SUPPORT_EMAIL, appVersion } from "@/lib/app-links";

export function SupportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!open) return;
    setCopied(false);
    close.current?.focus();
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [open, onClose]);
  if (!open) return null;
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section role="dialog" aria-modal="true" aria-labelledby="bos-support-title" className="w-full max-w-md rounded-2xl border border-hairline/50 bg-panel p-6 shadow-2xl">
      <h2 id="bos-support-title" className="text-lg font-semibold text-ink">Contact BOS</h2>
      <p className="mt-2 text-sm leading-relaxed text-ink-secondary">For help, alpha feedback or a privacy request, email:</p>
      <p className="mt-3 select-text break-all text-sm font-medium text-ink">{SUPPORT_EMAIL}</p>
      <button type="button" className="mt-2 text-sm text-accent hover:underline" onClick={() => void navigator.clipboard.writeText(SUPPORT_EMAIL).then(() => setCopied(true)).catch(() => setCopied(false))}>{copied ? "Copied" : "Copy email address"}</button>
      <p className="mt-4 text-xs leading-relaxed text-ink-secondary">Include BOS {appVersion()}, your device and steps to reproduce. Please leave out passwords, keys and private conversations. Nothing is sent automatically.</p>
      <button ref={close} type="button" onClick={onClose} className="mt-5 w-full rounded-xl bg-raised px-4 py-2 text-sm font-medium text-ink">Close</button>
    </section>
  </div>;
}
