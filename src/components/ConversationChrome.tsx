import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";
import { t } from "@/lib/i18n";

/** Common visual shell for local and federated conversations. */
export function ConversationHeader({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <div style={style} className="conversation-header @container/chathead flex items-center justify-between px-5 py-3 pl-11 md:pl-5">{children}</div>;
}

export function ConversationComposerFrame({ children }: { children: ReactNode }) {
  return <div data-tour="composer" className="conversation-composer relative z-[1] rounded-3xl bg-composer px-2 py-1.5 ring-1 ring-composer-ring">{children}</div>;
}

export function conversationBubbleClass(mine: boolean) {
  return `conversation-bubble w-fit max-w-[min(42rem,78%)] p-3 text-ink ${mine ? "bg-bubble-user whitespace-pre-wrap" : "bg-card"}`;
}

/** Secondary controls remain reachable at every width, including narrow windows. */
export function ConversationTools({ children }: { children: ReactNode }) {
  const details = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || details.current?.contains(target)) return;
      // Model and export pickers may render in a portal outside this disclosure.
      if (target.closest('[role="dialog"], [role="menu"]')) return;
      if (details.current) details.current.open = false;
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);
  return <details ref={details} onToggle={(event) => setOpen(event.currentTarget.open)} className="conversation-tools relative" onKeyDown={(event) => {
    if (event.key === "Escape" && !event.defaultPrevented && details.current?.open) {
      event.preventDefault(); event.stopPropagation(); details.current.open = false;
      details.current.querySelector("summary")?.focus();
    }
  }}>
    <summary role="button" aria-expanded={open} className="ui-icon-button cursor-pointer list-none rounded-lg hover:bg-raised focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent" aria-label={t("sidebar.tools")} title={t("sidebar.tools")}><MoreHorizontal size={18} /></summary>
    <div className="absolute right-0 top-full z-40 mt-2 flex w-72 max-w-[calc(100vw-2rem)] flex-wrap items-center gap-3 rounded-xl border border-hairline bg-card p-4 shadow-xl" role="group" aria-label={t("sidebar.tools")}>
      {children}
    </div>
  </details>;
}
