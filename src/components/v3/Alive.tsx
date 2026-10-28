// 3.0: the bot is alive on the desktop. The empty thread has it sitting big
// above the composer, watching the caret; a running turn turns the composer
// into a live island it stands in; a tab it works in wears it in the header;
// when it needs the person it comes forward and points at the button. Where
// it stands is the stage (lib/v3-stage); these are the places it can stand.
//
// Motion is transform/opacity only and nothing animates through React state:
// the caret gaze is one mutable object CursorAvatar reads every frame.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ChevronRight, ChevronUp, History, Square } from "lucide-react";
import { ActivityMascot } from "../ActivityMascot";
import { Glass } from "../Glass";
import { WorkingTimer } from "../WorkingIndicator";
import { track } from "@/lib/analytics";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { noteSteer, steerAckFresh, type SteerSeen } from "@/lib/steer-ack";
import { arrivedHome, faceHere, registerTabSlot, travelName, useStage, useStageVersion, walkingHome, walkingHomeIds } from "@/lib/v3-stage";
import { resolveMausColor } from "../../../shared/glyph-faces";
import { pointerGaze } from "@/lib/alive-eyes";
import { SPRINGS, TRAVEL, settleMs, springCss } from "../../../shared/mascot-motion";
import { useStore, type Bot } from "@/state/store";
import type { MascotGesture } from "../../../shared/mascot-choreography";
import { lineKey, MOOD_FACE, moodFor, pick, recentChips, type Mood } from "./alive-mood";
import "./alive.css";

type Gaze = { x?: number; y?: number };

// funnel: the first live island of an app session, not every running turn
let islandSeen = false;

function reduced(): boolean {
  return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

const clamp = (value: number) => Math.max(-1, Math.min(1, value));

/** The bot's face in the live island seat: the mascot while the turn runs,
 * a faint ring in its colour while it stands somewhere else. */
export function IslandFace({ bot, gesture, finishing, size = 34 }: {
  bot: Bot;
  gesture: MascotGesture;
  finishing: boolean;
  size?: number;
}) {
  const stage = useStage(bot.id);
  const here = faceHere(stage, "island");
  useEffect(() => {
    if (islandSeen) return;
    islandSeen = true;
    track("island_seen");
  }, []);
  return (
    <span className="flex size-9 shrink-0 items-center justify-center" style={travelName(stage, "island")} data-v3-face={here ? bot.id : undefined}>
      {here ? (
        <span className={cn("flex", finishing && "v3-hop")}>
          <ActivityMascot bot={bot} gesture={gesture} size={size} face={finishing ? "finished" : undefined} />
        </span>
      ) : (
        // the bot stepped out (a tab, the button it points at): its
        // place here stays a faint ring in its colour
        <EmptySeat bot={bot} size={Math.round(size * 0.7)} />
      )}
    </span>
  );
}

/** What the bot is doing right now, in words, with how long it has run. */
export function IslandLine({ label, since, needsYou, finishing, gotIt = false }: {
  label: string;
  since: number | null;
  needsYou: boolean;
  finishing: boolean;
  /** words just folded into the running turn: the line reads "got it" */
  gotIt?: boolean;
}) {
  return (
    <>
      {needsYou ? (
        <span className="truncate text-[13px] font-medium text-accent">{t("v3.island.needsYou")}</span>
      ) : finishing ? (
        <span className="truncate text-[13px] text-ink-secondary">{t("v3.island.done")}</span>
      ) : gotIt ? (
        <span key="got-it" className="status-swap truncate text-[13px] text-ink" role="status" aria-live="polite">
          {t("v3.island.gotIt")}
        </span>
      ) : (
        <span key={label} className="status-swap thinking-shimmer animate-shimmer truncate text-[13px]" aria-live="polite">
          {label}
        </span>
      )}
      {since !== null && !finishing && (
        <WorkingTimer since={since} className="ms-auto shrink-0 pe-1 text-[11.5px] text-ink-secondary/70" />
      )}
    </>
  );
}

/** The composer's live island: the bot's face and what it is doing. The chat
 * header carries the same face and line inside its name pill (IslandFace +
 * IslandLine); this standalone capsule is kept for surfaces with no header. */
export function LiveIsland({
  bot,
  gesture,
  label,
  since,
  needsYou,
  finishing,
  gotIt = false,
  onOpen,
  onStop,
}: {
  bot: Bot;
  gesture: MascotGesture;
  label: string;
  since: number | null;
  needsYou: boolean;
  finishing: boolean;
  /** words just folded into the running turn: the line reads "got it" */
  gotIt?: boolean;
  onOpen?: () => void;
  onStop?: () => void;
}) {
  return (
    <div className="flex justify-center px-5 pb-3" data-testid="v3-island">
      <Glass
        bezel={14}
        radius={23}
        className={cn(
          "v3-island flex h-[46px] w-[min(340px,100%)] items-center gap-1 rounded-full border border-hairline/50 bg-app py-1 pe-1.5 ps-1.5 shadow-[0_6px_24px_rgba(0,0,0,0.35)]",
          needsYou && "border-accent/60",
        )}
      >
        <button
          type="button"
          onClick={onOpen}
          disabled={!onOpen}
          aria-label={t("v3.island.open")}
          className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
        >
          <IslandFace bot={bot} gesture={gesture} finishing={finishing} />
          <IslandLine label={label} since={since} needsYou={needsYou} finishing={finishing} gotIt={gotIt} />
        </button>
        {onStop && !finishing && (
          <button
            type="button"
            onClick={onStop}
            aria-label={t("chat.stopTurn")}
            title={t("chat.stop")}
            className="flex size-8 shrink-0 items-center justify-center rounded-full bg-ink text-app transition-transform active:scale-90"
          >
            <Square size={12} className="fill-current" />
          </button>
        )}
      </Glass>
    </div>
  );
}

/** True for a moment after a steer lands in the turn you are watching, so
 * the island can say it took your words now rather than after. */
export function useSteerAck(scope: string, active: boolean, steeredId: string | undefined): boolean {
  const seen = useRef<SteerSeen>(noteSteer({ scope, ids: new Set() }, scope, steeredId));
  const [ack, setAck] = useState(false);
  useEffect(() => {
    const fresh = steerAckFresh(seen.current, scope, active, steeredId);
    seen.current = noteSteer(seen.current, scope, steeredId);
    if (!fresh) {
      setAck(false);
      return;
    }
    setAck(true);
    const timer = setTimeout(() => setAck(false), 1600);
    return () => clearTimeout(timer);
  }, [scope, active, steeredId]);
  return ack;
}

/** Where the caret sits on screen, measured from the text before it. */
function caretPoint(el: HTMLTextAreaElement, canvas: HTMLCanvasElement): { x: number; y: number } {
  const style = getComputedStyle(el);
  const ctx = canvas.getContext("2d");
  const rect = el.getBoundingClientRect();
  const padL = parseFloat(style.paddingLeft) || 0;
  const padT = parseFloat(style.paddingTop) || 0;
  const lineH = parseFloat(style.lineHeight) || 24;
  const avail = Math.max(1, el.clientWidth - padL - (parseFloat(style.paddingRight) || 0));
  const before = el.value.slice(0, el.selectionStart ?? el.value.length);
  const lines = before.split("\n");
  let rows = lines.length - 1;
  let width = 0;
  if (ctx) {
    ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    for (const [index, line] of lines.entries()) {
      const w = ctx.measureText(line).width;
      const wraps = Math.floor(w / avail);
      rows += wraps;
      if (index === lines.length - 1) width = w - wraps * avail;
    }
  }
  return { x: rect.left + padL + width, y: rect.top + padT + rows * lineH + lineH / 2 - el.scrollTop };
}

/** The empty thread: the bot sits big, watches the caret, reacts to the
 * draft, and offers the three threads it most recently worked on. */
export function EmptyMascot({ bot, profile, dock }: { bot: Bot; profile?: Bot; dock: RefObject<HTMLElement | null> }) {
  const { dispatch } = useStore();
  const stage = useStage(bot.id);
  // the one face: drawn here only once the stage has walked it out of its row
  const here = faceHere(stage, "empty");
  const host = useRef<HTMLDivElement>(null);
  const gaze = useRef<Gaze>({ x: 0, y: 0 });
  const [mood, setMood] = useState<Mood>("idle");
  const chips = useMemo(
    () => recentChips((profile ?? bot).tasks, bot.threadId),
    [profile, bot, bot.threadId],
  );

  useEffect(() => {
    const canvas = document.createElement("canvas");
    let previous = "";
    let lastInput = Date.now();
    let glanceTimer: ReturnType<typeof setTimeout> | undefined;
    let glanceBack: ReturnType<typeof setTimeout> | undefined;
    const area = () => dock.current?.querySelector("textarea") ?? null;
    let pointer: { x: number; y: number } | null = null;
    // not typing: the eyes follow the pointer while it is within reach and
    // drift back to the middle once it leaves
    const watched = () => {
      const me = host.current?.getBoundingClientRect();
      if (!pointer || !me || reduced()) return null;
      return pointerGaze(pointer, { x: me.left + me.width / 2, y: me.top + me.height / 2 });
    };
    const aim = () => {
      const el = area();
      const me = host.current?.getBoundingClientRect();
      if (!el || !me || document.activeElement !== el) {
        const look = watched();
        gaze.current.x = look?.x ?? 0;
        gaze.current.y = look?.y ?? 0;
        return;
      }
      const at = caretPoint(el, canvas);
      gaze.current.x = clamp((at.x - (me.left + me.width / 2)) / 260);
      gaze.current.y = clamp((at.y - (me.top + me.height / 2)) / 320);
    };
    const settle = () => {
      const el = area();
      const text = el?.value ?? "";
      const next = moodFor({
        text,
        previous,
        focused: Boolean(el && document.activeElement === el),
        idleS: (Date.now() - lastInput) / 1000,
      });
      previous = text;
      setMood((current) => (current === next ? current : next));
    };
    const onInput = (event: Event) => {
      if (event.target !== area()) return;
      lastInput = Date.now();
      aim();
      settle();
    };
    const onFocus = () => {
      lastInput = Date.now();
      aim();
      settle();
    };
    // a look around every 5–8s while nobody is typing; skipped under reduced motion
    const glance = () => {
      glanceTimer = setTimeout(() => {
        const el = area();
        if (!reduced() && Date.now() - lastInput > 4000 && document.activeElement !== el && !watched()) {
          gaze.current.x = Math.random() < 0.5 ? -0.8 : 0.8;
          gaze.current.y = -0.3 + Math.random() * 0.4;
          glanceBack = setTimeout(aim, 700);
        }
        glance();
      }, 5000 + Math.random() * 3000);
    };
    glance();
    let frame = 0;
    const onPointer = (event: PointerEvent) => {
      pointer = { x: event.clientX, y: event.clientY };
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; aim(); });
    };
    const onLeave = () => { pointer = null; aim(); };
    window.addEventListener("pointermove", onPointer, { passive: true });
    document.documentElement.addEventListener("pointerleave", onLeave);
    const doze = setInterval(settle, 5000);
    document.addEventListener("input", onInput, true);
    document.addEventListener("keyup", onInput, true);
    document.addEventListener("click", onInput, true);
    document.addEventListener("focusin", onFocus, true);
    document.addEventListener("focusout", onFocus, true);
    settle();
    return () => {
      clearTimeout(glanceTimer);
      clearTimeout(glanceBack);
      clearInterval(doze);
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", onPointer);
      document.documentElement.removeEventListener("pointerleave", onLeave);
      document.removeEventListener("input", onInput, true);
      document.removeEventListener("keyup", onInput, true);
      document.removeEventListener("click", onInput, true);
      document.removeEventListener("focusin", onFocus, true);
      document.removeEventListener("focusout", onFocus, true);
    };
  }, [dock, bot.threadId]);

  const line = useMemo(() => {
    const options = t(lineKey(mood, new Date())).split("|");
    return pick(options, `${bot.threadId}:${mood}`);
  }, [mood, bot.threadId]);

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 py-20 text-center" data-testid="v3-empty">
      <div ref={host} className="flex size-[112px] items-center justify-center" style={travelName(stage, "empty")} data-v3-face={here ? bot.id : undefined}>
        {here && <ActivityMascot bot={bot} gesture="idle" size={112} gaze={gaze.current} face={MOOD_FACE[mood]} blinkSlow={mood === "listening"} />}
      </div>
      <div key={line} className="status-swap text-[15px] text-ink-secondary">{line}</div>
      {chips.length > 0 && (
        <div className="mt-2 flex max-w-[560px] flex-wrap justify-center gap-2">
          {chips.map((task) => (
            <button
              key={task.threadId}
              type="button"
              onClick={() => dispatch({ type: "switchTask", botId: bot.id, threadId: task.threadId })}
              className="flex max-w-[240px] items-center gap-1.5 rounded-full border border-hairline/50 bg-panel px-3 py-1.5 text-[12.5px] text-ink-secondary transition-colors hover:bg-raised hover:text-ink"
              title={t("v3.empty.chip", { title: task.title })}
            >
              <History size={12} className="shrink-0" />
              <span className="truncate">{task.title}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

type Rect = { left: number; top: number; width: number; height: number };

export type { Rect as PointRect };

function measure(selector: string): Rect | null {
  const all = Array.from(document.querySelectorAll<HTMLElement>(selector)).filter(
    (el) => el.getClientRects().length > 0 && !(el as HTMLButtonElement).disabled,
  );
  // the newest visible one: a second card is the one waiting
  const el = all[all.length - 1];
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.bottom <= 0 || r.top >= window.innerHeight || r.right <= 0 || r.left >= window.innerWidth) return null;
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

const same = (a: Rect | null, b: Rect | null) =>
  a === b || Boolean(a && b && Math.abs(a.left - b.left) < 0.5 && Math.abs(a.top - b.top) < 0.5 && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5);

/** The button the bot is asking the person to press, while it asks. Same
 * observer set as the guided tour's spotlight; state changes only when the
 * button actually moves. */
export function usePointTarget(active: boolean, selector = "[data-v3-point]"): Rect | null {
  const [rect, setRect] = useState<Rect | null>(null);
  useLayoutEffect(() => {
    if (!active) {
      setRect(null);
      return;
    }
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const next = measure(selector);
        setRect((prev) => (same(prev, next) ? prev : next));
      });
    };
    update();
    const mo = new MutationObserver(update);
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "disabled", "open", "aria-expanded"] });
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      cancelAnimationFrame(frame);
      mo.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [active, selector]);
  return rect;
}

const POINT = 44;

/** The bot in front of the window, beside the button, pointing at it. A
 * teach step adds one line of why and a "got it". */
export function PointingMascot({ bot, target, caption, onDismiss }: { bot: Bot; target: Rect | null; caption?: string; onDismiss?: () => void }) {
  const stage = useStage(bot.id);
  if (!target || stage.spot !== "pointing") return null;
  // above, pointing down, keeps the neighbouring buttons readable; beside
  // only when the button sits at the top edge
  const beside = target.top - POINT - 18 < 8 && target.left - POINT - 22 >= 8;
  const left = beside ? target.left - POINT - 22 : Math.min(window.innerWidth - POINT - 8, Math.max(8, target.left + target.width / 2 - POINT / 2));
  const top = beside ? target.top + target.height / 2 - POINT / 2 : Math.max(8, target.top - POINT - 18);
  return createPortal(
    <div className="pointer-events-none fixed inset-0 z-[55]" data-testid="v3-pointing">
      <div
        aria-hidden
        className="v3-point-ring absolute rounded-[12px] ring-2 ring-accent"
        style={{ left: target.left - 4, top: target.top - 4, width: target.width + 8, height: target.height + 8 }}
      />
      <div className="absolute flex items-center" style={{ left, top, flexDirection: beside ? "row" : "column" }}>
        <span className="flex" style={travelName(stage, "pointing")} data-v3-face={bot.id}>
          {/* leans toward the button and knocks on it once every 8s */}
          <span className={cn("flex", beside ? "v3-point-knock-x" : "v3-point-knock-y")}>
            {/* upright: the waiting gesture settles into a puddle, wrong for pointing */}
            <ActivityMascot bot={bot} gesture="idle" face="waiting" size={POINT} />
          </span>
        </span>
        {beside
          ? <ChevronRight size={18} className="v3-point-knock-x text-accent" />
          : <span className="v3-point-knock-y flex"><ChevronUp size={18} className="rotate-180 text-accent" /></span>}
      </div>
      {caption && (
        <div
          role="status"
          className="v3-point-ring pointer-events-auto absolute flex max-w-[260px] items-center gap-2 rounded-xl border border-hairline/60 bg-card px-3 py-2 text-[13px] text-ink shadow-lg"
          style={captionAt(target, beside, left, top)}
          data-testid="v3-teach-caption"
        >
          <span className="min-w-0">{caption}</span>
          {onDismiss && (
            <button type="button" onClick={onDismiss} className="shrink-0 rounded-full px-2 py-0.5 text-[12px] font-medium text-accent hover:bg-accent/10">
              {t("v3.teach.gotIt")}
            </button>
          )}
        </div>
      )}
    </div>,
    document.body,
  );
}

/** The caption sits on the side of the mascot away from the button, kept on screen. */
function captionAt(target: Rect, beside: boolean, left: number, top: number): React.CSSProperties {
  const width = 260;
  if (beside) {
    return { left: Math.max(8, left - width - 8), top: Math.max(8, top) };
  }
  const x = Math.min(window.innerWidth - width - 8, Math.max(8, target.left + target.width / 2 - width / 2));
  // grows upward from just above the mascot, however many lines it wraps to
  return { left: x, bottom: Math.max(8, window.innerHeight - top + 4) };
}

/** A tab the bot is working in: it walks into the header in place of the
 * tab's icon. Mounting registers the slot, so the stage sends it here. */
export function TabMascot({ botId, fallback }: { botId: string; fallback: React.ReactNode }) {
  const { state } = useStore();
  const bot = state.bots.find((candidate) => candidate.id === botId);
  const stage = useStage(botId);
  useEffect(() => registerTabSlot(botId), [botId]);
  if (!bot || stage.spot !== "tab") return <>{fallback}</>;
  return (
    <span className="flex size-4 shrink-0 items-center justify-center overflow-visible" style={travelName(stage, "tab")} data-testid="v3-tab-mascot" data-v3-face={botId}>
      <ActivityMascot bot={bot} gesture="working" size={20} />
    </span>
  );
}

/** On a page the bot drives, the bot is the cursor. */
export function CursorMascot({ botId, x, y }: { botId: string | null | undefined; x: number; y: number }) {
  const { state } = useStore();
  const bot = state.bots.find((candidate) => candidate.id === botId);
  if (!bot) return null;
  return (
    <span className="v3-cursor-mascot" style={{ transform: `translate3d(${x}px, ${y}px, 0)` }} aria-hidden data-testid="v3-cursor-mascot">
      <ActivityMascot bot={bot} gesture="working" size={28} />
    </span>
  );
}

/** Where a bot's face would be when it is drawn somewhere else: a faint
 * ring in its own colour, so the eye still finds whose seat it is. */
export function EmptySeat({ bot, size }: { bot: Pick<Bot, "color">; size: number }) {
  return (
    <span
      aria-hidden
      className="rounded-full border-[1.5px]"
      style={{ width: size, height: size, borderColor: `color-mix(in srgb, ${resolveMausColor(bot.color)} 45%, transparent)` }}
    />
  );
}

type Box = { left: number; top: number; width: number; height: number };

/** A bot whose chat closed under it walks back to its row above the page,
 * from where it last stood, then the row draws it again. */
export function WalkHomeLayer() {
  useStageVersion();
  const { state } = useStore();
  const ids = walkingHomeIds();
  useEffect(() => {
    for (const id of ids) if (!state.bots.some((bot) => bot.id === id)) arrivedHome(id);
  });
  if (ids.length === 0) return null;
  return createPortal(
    <div className="pointer-events-none fixed inset-0 z-[60]" aria-hidden data-testid="v3-walk-home">
      {ids.map((id) => {
        const bot = state.bots.find((candidate) => candidate.id === id);
        const from = walkingHome(id);
        return bot && from ? <WalkGhost key={id} bot={bot} from={from} /> : null;
      })}
    </div>,
    document.body,
  );
}

function WalkGhost({ bot, from }: { bot: Bot; from: Box }) {
  const ref = useRef<HTMLDivElement>(null);
  const [seat, setSeat] = useState<Box | null>(null);
  useLayoutEffect(() => {
    const el = document.querySelector<HTMLElement>(`[data-v3-seat="${CSS.escape(bot.id)}"]`);
    const r = el?.getBoundingClientRect();
    // a folded sidebar or a row scrolled away: it is simply home
    if (!r || r.width === 0 || r.bottom <= 0 || r.top >= window.innerHeight) {
      arrivedHome(bot.id);
      return;
    }
    setSeat({ left: r.left, top: r.top, width: r.width, height: r.height });
  }, [bot.id]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !seat) return;
    const dx = from.left + from.width / 2 - (seat.left + seat.width / 2);
    const dy = from.top + from.height / 2 - (seat.top + seat.height / 2);
    const scale = from.width / seat.width;
    const lift = Math.min(TRAVEL.arcMaxPx, Math.hypot(dx, dy) * TRAVEL.arcLift);
    const animation = el.animate([
      { transform: `translate(${dx}px, ${dy}px) scale(${scale})` },
      { transform: `translate(${dx * 0.45}px, ${dy * 0.45 - lift}px) scale(${1 + (scale - 1) * 0.45})`, offset: 0.45 },
      { transform: `translate(0, 0) scale(1.06, ${TRAVEL.landSquash})`, offset: 0.85 },
      { transform: "none" },
    ], { duration: settleMs(SPRINGS.travel), easing: springCss(SPRINGS.glide) });
    let live = true;
    void animation.finished.then(() => { if (live) arrivedHome(bot.id); }, () => {});
    return () => {
      live = false;
      animation.cancel();
    };
  }, [seat, from, bot.id]);
  if (!seat) return null;
  return (
    <div ref={ref} className="absolute flex items-center justify-center" style={{ left: seat.left, top: seat.top, width: seat.width, height: seat.height, transformOrigin: "50% 100%" }}>
      <ActivityMascot bot={bot} gesture="idle" size={seat.width} />
    </div>
  );
}
