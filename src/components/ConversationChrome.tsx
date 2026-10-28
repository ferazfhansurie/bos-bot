import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { MoreHorizontal, Plus } from "lucide-react";
import { t } from "@/lib/i18n";
import { Glass } from "./Glass";

/** Common visual shell for local and federated conversations. */
export function ConversationHeader({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <div style={style} className="conversation-header @container/chathead flex items-center justify-between px-5 py-3 pl-11 md:pl-5">{children}</div>;
}

export function ConversationComposerFrame({ children }: { children: ReactNode }) {
  return <Glass data-tour="composer" bezel={18} className="conversation-composer relative z-[1] rounded-[28px] bg-composer py-1.5 pe-1.5 ps-1.5 ring-1 ring-composer-ring">{children}</Glass>;
}

export function conversationBubbleClass(mine: boolean) {
  return `conversation-bubble w-fit max-w-[min(42rem,78%)] p-3 text-ink ${mine ? "bg-bubble-user whitespace-pre-wrap" : "bg-card"}`;
}

/** Secondary controls remain reachable at every width, including narrow windows. */
export function ConversationTools({ children, composer = false }: { children: ReactNode; composer?: boolean }) {
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
  return <details ref={details} onToggle={(event) => setOpen(event.currentTarget.open)} className={`conversation-tools relative ${composer ? "composer-tools" : ""}`} onKeyDown={(event) => {
    if (event.key === "Escape" && !event.defaultPrevented && details.current?.open) {
      event.preventDefault(); event.stopPropagation(); details.current.open = false;
      details.current.querySelector("summary")?.focus();
    }
  }}>
    <summary role="button" aria-expanded={open} className={`ui-icon-button cursor-pointer list-none hover:bg-raised ${composer ? "composer-plus" : "rounded-lg"} focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent`} aria-label={composer ? "Add and options" : "Conversation options"} title={composer ? "Add and options" : "Conversation options"}>{composer ? <Plus size={20} /> : <MoreHorizontal size={18} />}</summary>
    <div className={`absolute z-40 flex w-64 max-w-[calc(100vw-2rem)] flex-col items-stretch gap-1 rounded-xl border border-hairline bg-card p-2 shadow-xl ${composer ? "left-0 bottom-full mb-2" : "right-0 top-full mt-2"}`} role="group" aria-label={t("sidebar.tools")}>
      {children}
    </div>
  </details>;
}
