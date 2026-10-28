import { resolveMausColor } from "../../shared/glyph-faces";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, Copy, Share, ThumbsDown, ThumbsUp } from "lucide-react";
import { BotAvatar, GroupMark } from "./Avatar";
import { activeLocale } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { api, type Bot } from "@/state/store";
import { analyticsEnabled } from "@/lib/analytics";
import { confirmUsefulResult } from "@/lib/product-feedback";
import { useAppConfig } from "@/lib/app-config";
import { ProductFeedback } from "./ProductFeedback";

/** One ghost icon button in a turn's action row: tertiary glyph, 18px,
 * ghost-hover square on hover (chatgpt's `color: ghost, size: icon`). */
export const turnActionClass = "chat-ghost inline-flex items-center justify-center p-1 disabled:cursor-not-allowed disabled:opacity-40";

export const GOOD = "👍";
export const BAD = "👎";

/** "Oct 16, 2026, 1:05 AM" — chatgpt's compact datetime on hover. */
export function turnTimestamp(at: number): string {
  return new Date(at).toLocaleString(activeLocale(), {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function TurnCopyButton({ text, label = "Copy response" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch { /* clipboard denied: retain the copy action */ }
      }}
      aria-label={copied ? "Copied" : label}
      title={label}
      className={turnActionClass}
    >
      {copied ? <Check size={18} aria-hidden="true" /> : <Copy size={18} aria-hidden="true" />}
    </button>
  );
}

/** Good / bad response. Backed by the message's reactions, so one is on at a
 * time: picking the other turns the first off. */
export function FeedbackButtons({ active, onReact }: { active: { good: boolean; bad: boolean }; onReact: (emoji: string) => void }) {
  const config = useAppConfig();
  const [rating, setRating] = useState<"up" | "down" | null>(null);
  const dialog = useRef<HTMLElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!rating) return;
    const previous = opener.current;
    return () => previous?.focus();
  }, [rating]);
  const pick = (emoji: string) => {
    const other = emoji === GOOD ? active.bad && BAD : active.good && GOOD;
    if (other) onReact(other);
    onReact(emoji);
    // A thumbs-up is the person confirming a useful result; the server only
    // records first_job_done when a turn really finished successfully.
    if (emoji === GOOD && !active.good && analyticsEnabled()) void confirmUsefulResult(true, api).catch(() => {});
    if (config.flags.feedback && !(emoji === GOOD ? active.good : active.bad)) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setRating(emoji === GOOD ? "up" : "down");
    }
  };
  return (
    <>
      {rating && config.flags.feedback && createPortal(<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6" onMouseDown={event => { if (event.target === event.currentTarget) setRating(null); }} onKeyDown={event => {
        if (event.key === "Escape") { event.stopPropagation(); setRating(null); }
        if (event.key !== "Tab") return;
        const controls = dialog.current?.querySelectorAll<HTMLElement>("input:enabled, button:enabled");
        const first = controls?.[0], last = controls?.[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}>
        <section ref={dialog} role="dialog" aria-modal="true" aria-label="Share response rating" className="w-full max-w-sm rounded-2xl border border-hairline/50 bg-panel p-5 shadow-2xl">
          <h2 className="font-semibold text-ink">Share this rating with Firaz?</h2>
          <ProductFeedback key={rating} rating={rating} />
          <button autoFocus type="button" className="ui-button mt-4" onClick={() => setRating(null)}>Close</button>
        </section>
      </div>, document.body)}
      {!active.bad && (
        <button
          type="button"
          onClick={() => pick(GOOD)}
          aria-label={active.good ? "Remove good response feedback" : "Good response"}
          aria-pressed={active.good}
          title="Good response"
          className={turnActionClass}
        >
          <ThumbsUp size={18} aria-hidden="true" className={cn(active.good && "fill-current")} />
        </button>
      )}
      {!active.good && (
        <button
          type="button"
          onClick={() => pick(BAD)}
          aria-label={active.bad ? "Remove bad response feedback" : "Bad response"}
          aria-pressed={active.bad}
          title="Bad response"
          className={turnActionClass}
        >
          <ThumbsDown size={18} aria-hidden="true" className={cn(active.bad && "fill-current")} />
        </button>
      )}
    </>
  );
}

/** The system share sheet where there is one; otherwise the text goes to the
 * clipboard and the glyph says so. */
export function ShareButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        if (typeof navigator.share === "function") {
          void navigator.share({ text }).catch(() => {});
          return;
        }
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch { /* no share receipt until clipboard succeeds */ }
      }}
      aria-label="Share"
      title="Share"
      className={turnActionClass}
    >
      {copied ? <Check size={18} aria-hidden="true" /> : <Share size={18} aria-hidden="true" />}
    </button>
  );
}

/** chatgpt's row under a turn: 6px down, 2px gaps, nudged 4px left so the
 * glyphs line up with the prose edge. Hover-only unless `persistent`. */
export function TurnActionRow({
  persistent,
  align = "start",
  at,
  children,
}: {
  persistent: boolean;
  align?: "start" | "end";
  at?: number;
  children: ReactNode;
}) {
  const time = at ? (
    <span
      data-testid="turn-time"
      className="chat-text-tertiary pointer-events-none flex min-h-5 shrink-0 items-center text-xs leading-4 select-none tabular-nums opacity-0 transition-opacity group-hover:opacity-100"
    >
      {turnTimestamp(at)}
    </span>
  ) : null;
  return (
    <div
      data-testid="turn-actions"
      className={cn(
        "turn-action-controls mt-1.5 flex min-h-5 min-w-0 flex-wrap items-center gap-0.5 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100",
        align === "end" ? "translate-x-1 justify-end" : "-translate-x-1 justify-start",
        persistent ? "opacity-100" : "opacity-0",
      )}
    >
      {align === "end" && time && <span className="me-1.5 flex">{time}</span>}
      {children}
      {align === "start" && time && <span className="ms-1.5 flex">{time}</span>}
    </div>
  );
}

/** Firaz's one change to chatgpt: who is talking, beside the first line of
 * each bot reply — avatar plus name, slack-style, in 1:1s and rooms. */
/** A person in a shared chat gets their face, not a mascot. */
export function SpeakerHeader({ bot, name, person, faceless }: { bot: Pick<Bot, "name" | "color"> & Partial<Bot>; name: string; person?: { avatar?: string | null }; faceless?: boolean }) {
  if (faceless && !person) {
    return (
      <div data-testid="speaker-header" className="flex min-w-0 items-center">
        <span className="truncate text-[14px] leading-5 font-semibold" style={{ color: resolveMausColor(bot.color) }}>{name}</span>
      </div>
    );
  }
  return (
    <div data-testid="speaker-header" className="flex min-w-0 items-center gap-2">
      {person ? <GroupMark members={[{ id: name, name, kind: "person", avatar: person.avatar }]} size={22} /> : <BotAvatar bot={bot} size={22} animated={false} />}
      <span className="truncate text-[14px] leading-5 font-semibold text-ink">{name}</span>
    </div>
  );
}
