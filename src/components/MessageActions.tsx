import { useEffect, useRef, useState, type ReactNode } from "react";
import { Ellipsis, MessageSquareReply, Smile } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";

/** Class shared by every control that lives inside the "…" menu. The menu
 * lays each one out as a row and prints its aria-label beside the icon
 * (see `.message-menu` in styles.css), so the controls stay icon buttons. */
export const messageActionClass =
  "rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-ink-secondary";

export const REACTIONS = ["👍", "❤️", "😂", "🎉", "👀", "✅"];

const quickClass =
  "flex size-8 items-center justify-center rounded-full text-ink-secondary transition-colors hover:bg-raised hover:text-ink";

type Popover = "react" | "menu" | null;

/** Grok's hover row beside a bubble: react, reply, and "…" for the rest
 * (copy, read aloud, raw markdown, pin, edit, regenerate). Nothing shows on
 * an idle message; hovering or focusing the message brings the row in.
 *
 * `forceOpen` keeps the row visible and the menu's controls inline while one
 * of them has to stay reachable (a message being read aloud, raw markdown
 * showing). Children render in reading order; the row mirrors on the user
 * side so react stays nearest the bubble on both sides. */
export function MessageActions({
  side,
  forceOpen = false,
  className,
  onReply,
  onReact,
  children,
}: {
  side: "user" | "bot";
  forceOpen?: boolean;
  className?: string;
  onReply?: () => void;
  onReact?: (emoji: string) => void;
  children: ReactNode;
}) {
  const [popover, setPopover] = useState<Popover>(null);
  const root = useRef<HTMLDivElement>(null);
  const open = popover !== null || forceOpen;
  const mirrored = side === "user";

  useEffect(() => {
    if (!popover) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && root.current?.contains(event.target)) return;
      setPopover(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPopover(null);
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, [popover]);

  const toggle = (next: Exclude<Popover, null>) => setPopover((current) => (current === next ? null : next));
  const popoverSide = mirrored ? "right-0" : "left-0";

  return (
    <div
      ref={root}
      className={cn(
        "relative flex items-center gap-0.5 self-center transition-opacity duration-150 focus-within:opacity-100 group-hover:opacity-100",
        mirrored && "flex-row-reverse",
        open ? "opacity-100" : "opacity-0",
        className,
      )}
      data-testid="message-actions"
      data-open={open ? "true" : undefined}
    >
      {onReact && (
        <button type="button" onClick={() => toggle("react")} aria-label="React" title="React" aria-expanded={popover === "react"} className={cn(quickClass, popover === "react" && "bg-raised text-ink")}>
          <Smile size={18} aria-hidden="true" />
        </button>
      )}
      {onReply && (
        <button type="button" onClick={onReply} aria-label={t("chat.replyToMessage")} title={t("chat.reply")} className={quickClass}>
          <MessageSquareReply size={18} aria-hidden="true" />
        </button>
      )}
      {forceOpen && <div className={cn("flex items-center gap-0.5", mirrored && "flex-row-reverse")}>{children}</div>}
      <button
        type="button"
        onClick={() => toggle("menu")}
        aria-label={t("chat.messageActions")}
        title={t("chat.messageActions")}
        aria-haspopup="menu"
        aria-expanded={popover === "menu"}
        className={cn(quickClass, popover === "menu" && "bg-raised text-ink")}
      >
        <Ellipsis size={18} aria-hidden="true" />
      </button>

      {popover === "react" && onReact && (
        <div role="dialog" aria-label="React" className={cn("animate-pop-in absolute top-full z-30 mt-1 flex gap-0.5 rounded-full border border-hairline/50 bg-menu p-1 shadow-2xl shadow-black/50", popoverSide)}>
          {REACTIONS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              aria-label={`React ${emoji}`}
              onClick={() => {
                onReact(emoji);
                setPopover(null);
              }}
              className="flex size-9 items-center justify-center rounded-full text-[18px] transition-transform hover:scale-110 hover:bg-raised"
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
      {/* always mounted (hidden while closed) so the controls keep their
          own state between openings */}
      {!forceOpen && (
        <div
          role="menu"
          hidden={popover !== "menu"}
          aria-label={t("chat.messageActions")}
          // a control that changes the message (copy, pin) closes the menu;
          // one that keeps going (read aloud) keeps the row pinned via forceOpen
          onClick={(event) => {
            if ((event.target as HTMLElement).closest("button")) window.setTimeout(() => setPopover(null), 120);
          }}
          className={cn("message-menu animate-pop-in absolute top-full z-30 mt-1 flex min-w-[190px] flex-col rounded-xl border border-hairline/50 bg-menu p-1 shadow-2xl shadow-black/50", popoverSide, popover !== "menu" && "!hidden")}
        >
          {children}
        </div>
      )}
    </div>
  );
}
