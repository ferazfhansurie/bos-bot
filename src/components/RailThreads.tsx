import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { Loader2, Phone, Plus } from "lucide-react";
import { type Bot, useStore } from "@/state/store";
import { useActivityFeed, withLiveActivity } from "@/lib/activity-feed";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { callsAt, compactThreads, readThreadPins, threadTime } from "./CompactBotThreads";

/** Hover long enough to mean it; a pass down the rail opens nothing. */
export const RAIL_OPEN_DELAY = 250;
/** Long enough to cross the gap from the avatar into the panel. */
const RAIL_CLOSE_DELAY = 160;
const RAIL_HOLD = 450;
const RAIL_THREADS = 8;
/** Once one panel was open, the next avatar opens at once: skimming the
 * rail reads like a menu bar, not a row of separate tooltips. */
const SKIM_WINDOW = 400;
let lastClosedAt = 0;

export const railOpenDelay = (now: number, closedAt: number) => now - closedAt < SKIM_WINDOW ? 0 : RAIL_OPEN_DELAY;

/** The avatar rail's thread switcher: nothing new sits on the rail, a bot's
 * recent threads slide out beside its avatar on hover, keyboard focus or a
 * touch long-press. */
export function useRailThreads(bot: Bot, enabled: boolean) {
  const rowRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const held = useRef(false);
  const touch = useRef(false);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [focusFirst, setFocusFirst] = useState(false);
  const clear = () => window.clearTimeout(timer.current);
  const later = (fn: () => void, ms: number) => { clear(); timer.current = window.setTimeout(fn, ms); };
  const show = useCallback(() => {
    window.clearTimeout(timer.current);
    const rect = rowRef.current?.getBoundingClientRect();
    if (rect) setAnchor(rect);
  }, []);
  const hide = useCallback(() => {
    window.clearTimeout(timer.current);
    setAnchor((open) => { if (open) lastClosedAt = Date.now(); return null; });
    setFocusFirst(false);
  }, []);
  const open = anchor !== null;
  const inside = (node: EventTarget | null) => node instanceof Node && Boolean(rowRef.current?.contains(node) || panelRef.current?.contains(node));

  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEffect(() => { if (!enabled) hide(); }, [enabled, hide]);
  useEffect(() => {
    if (!open) return;
    // the anchor rect goes stale on scroll or resize; a touch-opened panel
    // has no mouse-out, so a tap elsewhere closes it
    const stale = (event: Event) => { if (!inside(event.target)) hide(); };
    const away = (event: globalThis.PointerEvent) => { if (!inside(event.target)) hide(); };
    window.addEventListener("scroll", stale, true);
    window.addEventListener("resize", hide);
    window.addEventListener("pointerdown", away, true);
    return () => { window.removeEventListener("scroll", stale, true); window.removeEventListener("resize", hide); window.removeEventListener("pointerdown", away, true); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, hide]);

  const rowProps = enabled ? {
    ref: rowRef,
    onPointerEnter: (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      if (open) clear(); else later(show, railOpenDelay(Date.now(), lastClosedAt));
    },
    onPointerLeave: (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      if (open) later(hide, RAIL_CLOSE_DELAY); else clear();
    },
    onPointerDown: (event: PointerEvent) => {
      touch.current = event.pointerType === "touch";
      held.current = false;
      if (touch.current) later(() => { held.current = true; show(); }, RAIL_HOLD);
    },
    onPointerUp: () => { if (touch.current && !held.current) clear(); },
    onPointerCancel: () => { if (!held.current) clear(); },
    // a long-press opened the panel: the lift must not also select the bot
    onClickCapture: (event: MouseEvent) => {
      if (!held.current) { hide(); return; }
      held.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
    onContextMenuCapture: (event: MouseEvent) => {
      if (touch.current) {
        event.preventDefault();
        event.stopPropagation();
        held.current = true;
        show();
        return;
      }
      hide();
    },
    onFocus: (event: FocusEvent) => {
      if (event.target instanceof HTMLElement && event.target.matches(":focus-visible") && !open) later(show, RAIL_OPEN_DELAY);
    },
    onBlur: (event: FocusEvent) => { if (!inside(event.relatedTarget)) later(hide, RAIL_CLOSE_DELAY); },
    onKeyDownCapture: (event: KeyboardEvent) => {
      if (event.key === "ArrowRight") { event.preventDefault(); setFocusFirst(true); show(); }
      else if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); hide(); }
    },
  } : { ref: rowRef };

  const flyout = enabled && anchor ? <RailThreadsPanel bot={bot} anchor={anchor} panelRef={panelRef} focusFirst={focusFirst}
    onEnter={clear} onLeave={() => later(hide, RAIL_CLOSE_DELAY)}
    onBlur={(event) => { if (!inside(event.relatedTarget)) later(hide, RAIL_CLOSE_DELAY); }}
    onClose={(refocus) => { hide(); if (refocus) rowRef.current?.querySelector<HTMLElement>("[data-sidebar-bot-row]")?.focus(); }} /> : null;
  return { rowProps, flyout, open };
}

function RailThreadsPanel({ bot, anchor, panelRef, focusFirst, onEnter, onLeave, onBlur, onClose }: {
  bot: Bot;
  anchor: DOMRect;
  panelRef: React.RefObject<HTMLDivElement | null>;
  focusFirst: boolean;
  onEnter: () => void;
  onLeave: () => void;
  onBlur: (event: FocusEvent) => void;
  onClose: (refocus: boolean) => void;
}) {
  const { state, dispatch } = useStore();
  useActivityFeed();
  const active = state.pendingThreadSwitch[bot.id] ?? bot.threadId;
  const threads = compactThreads(bot.tasks ?? [], readThreadPins(bot.id), active, RAIL_THREADS);
  const [top, setTop] = useState(anchor.top - 2);
  useLayoutEffect(() => {
    const height = panelRef.current?.offsetHeight ?? 0;
    setTop(Math.max(8, Math.min(anchor.top - 2, window.innerHeight - height - 8)));
  }, [anchor, panelRef, threads.length]);
  useEffect(() => {
    if (focusFirst) panelRef.current?.querySelector<HTMLElement>("[data-rail-thread]")?.focus();
  }, [focusFirst, panelRef]);
  const items = () => Array.from(panelRef.current?.querySelectorAll<HTMLElement>("button") ?? []);
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape" || event.key === "ArrowLeft") { event.preventDefault(); event.stopPropagation(); onClose(true); return; }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    event.stopPropagation();
    const all = items();
    const at = all.indexOf(document.activeElement as HTMLElement);
    all[(at + (event.key === "ArrowDown" ? 1 : -1) + all.length) % all.length]?.focus();
  };
  return createPortal(
    <div ref={panelRef} data-sidebar data-rail-threads={bot.id} role="menu" aria-label={`${bot.name} threads`}
      style={{ top, left: anchor.right + 6 }} onPointerEnter={onEnter} onPointerLeave={(event) => { if (event.pointerType !== "touch") onLeave(); }}
      onBlur={onBlur} onKeyDown={onKeyDown}
      className="fixed z-40 max-h-[calc(100dvh-16px)] w-[264px] origin-top-left overflow-y-auto overscroll-contain rounded-xl border border-hairline/50 bg-menu p-1.5 shadow-2xl shadow-black/60 motion-safe:animate-pop-in">
      <div className="flex items-center justify-between gap-2 pb-1 pl-2">
        <span className="min-w-0 truncate text-[12px] font-medium text-ink-secondary">{bot.name}</span>
        <button type="button" role="menuitem" aria-label={t("task.newShort")} title={t("task.newShort")}
          onClick={() => { onClose(false); dispatch({ type: "newTask", botId: bot.id }); }}
          className="flex size-7 shrink-0 items-center justify-center rounded text-ink-secondary outline-none hover:bg-raised hover:text-ink focus-visible:bg-raised"><Plus size={13} /></button>
      </div>
      {threads.map((thread) => {
        const task = withLiveActivity(bot.id, thread);
        const current = task.threadId === active;
        const working = task.activity === "working" || Boolean(task.busy);
        const at = callsAt(task);
        return <button key={task.threadId} type="button" role="menuitem" data-rail-thread={task.threadId} aria-current={current ? "page" : undefined}
          title={[task.title, task.activity === "waiting-on-you" ? t("task.waiting") : working ? t("chat.activity.working") : null, task.unread ? t("task.unread") : null].filter(Boolean).join(" · ")}
          onPointerEnter={bot.remote || bot.homeLink || current ? undefined : (event) => { if (event.pointerType !== "touch") dispatch({ type: "prefetchThread", threadId: task.threadId }); }}
          onFocus={bot.remote || bot.homeLink || current ? undefined : () => dispatch({ type: "prefetchThread", threadId: task.threadId })}
          onClick={() => { onClose(false); if (!(current && state.selectedId === bot.id && state.activeView === "chat")) dispatch({ type: "switchTask", botId: bot.id, threadId: task.threadId }); }}
          className={cn("flex min-h-8 w-full min-w-0 items-center gap-2 rounded-[10px] px-2 py-1 text-left text-[12.5px] font-medium text-ink outline-none",
            current ? "bg-raised" : "hover:bg-raised/50 focus-visible:bg-raised/50")}>
          {task.voiceCalls && <Phone size={11} className="shrink-0 text-accent" aria-hidden />}
          <span className={cn("min-w-0 flex-1 truncate", task.unread && "font-semibold")}>{task.title}</span>
          {task.activity === "waiting-on-you" ? <span className="shrink-0 text-[12px] font-medium text-warning">{t("task.waiting")}</span>
            : working ? <Loader2 size={11} className="shrink-0 animate-spin text-accent" aria-label={t("chat.activity.working")} /> : null}
          {task.unread && <span className="size-1.5 shrink-0 rounded-full bg-accent" aria-label={t("task.unread")} />}
          {at ? <time dateTime={new Date(at).toISOString()} className="shrink-0 text-[10px] font-normal tabular-nums text-ink-secondary/70">{threadTime(at)}</time> : null}
        </button>;
      })}
    </div>,
    document.body,
  );
}
