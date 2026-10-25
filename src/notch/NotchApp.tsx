// The notch page (electron/notch.mjs). One black shape hung from the top of
// the screen, grown and folded on springs, and the bots inside it. It holds
// no data of its own: the main window sends a snapshot, and every action
// goes back there to run through the app's own paths.
//
// What it shows, in order of priority:
//   shelf   the pointer is on it (or a file is being dragged to it)
//   card    a bot just started waiting on the person: it climbs out
//   moment  a bot just finished, or failed
//   peek    bots are working: their faces at the camera's edge, still
//   rest    nothing: no shape at all; a click on the camera opens the shelf
//
// Nothing moves unless it needs the person: a working bot's face holds
// still, an app full screen sees only asks, and in a menu bar without a
// camera the pill stays inside the bar.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from "react";
import { resolveMausColor, type GlyphFaceState } from "../../shared/glyph-faces";
import { FOLD_SPRING, SHAPE_SPRING, Spring, notchPath } from "./spring";
import { NotchMascot, faceFor } from "./NotchMascot";
import { MOMENT_MS } from "./feed";
import type { NotchAction, NotchAnswer, NotchAsk, NotchBot, NotchGeometry, NotchMoment, NotchPointer, NotchSnapshot } from "./types";

interface NotchBridge {
  onGeometry(cb: (geometry: NotchGeometry) => void): () => void;
  onSnapshot(cb: (snapshot: NotchSnapshot) => void): () => void;
  onPointer(cb: (pointer: NotchPointer) => void): () => void;
  setInteractive(on: boolean | "keys"): void;
  setShape(width: number, height: number): void;
  act(action: NotchAction): void;
  drop(botId: string, threadId: string, files: File[]): number;
}

declare global {
  interface Window {
    notch?: NotchBridge;
  }
}

const HEAD = 22;
const STEP = 15;
const PAD = 10;
const EAR = 6;
const CLIMBED = 34;
const OPEN_WIDTH = 420;
const MOMENT_WIDTH = 340;
const MAX_HEADS = 3;
const MAX_ROWS = 7;
const MAX_SHELF_ASKS = 2;
const DWELL_MS = 200;
const LEAVE_GRACE_MS = 220;
const CARD_MS = 7_000;
const HAPPY_MS = 1_400;

const EMPTY: NotchSnapshot = { working: [], shelf: [], bots: {}, asks: [], moments: [] };

type Mode = "hidden" | "rest" | "peek" | "card" | "moment" | "shelf";
type Look = Pick<NotchBot, "id" | "name" | "color" | "body">;
interface Head extends Look {
  face: GlyphFaceState;
  threadId: string;
}

function useReducedMotion(): boolean {
  const query = useMemo(() => window.matchMedia("(prefers-reduced-motion: reduce)"), []);
  const [reduced, setReduced] = useState(query.matches);
  useEffect(() => {
    const update = () => setReduced(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, [query]);
  return reduced;
}

export function elapsed(since: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - since) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
}

const STATE_WORD: Record<NotchBot["state"], string> = {
  waiting: "needs you",
  tool: "working",
  typing: "working",
  thinking: "working",
  failed: "failed",
  stopped: "stopped",
  idle: "",
};

export function NotchApp() {
  const bridge = window.notch;
  const reduced = useReducedMotion();
  const [geometry, setGeometry] = useState<NotchGeometry | null>(null);
  const [snap, setSnap] = useState<NotchSnapshot>(EMPTY);
  const [hover, setHover] = useState(false);
  const [drag, setDrag] = useState(false);
  const [shelf, setShelf] = useState(false);
  const [cardId, setCardId] = useState<string | null>(null);
  const [answered, setAnswered] = useState<ReadonlySet<string>>(() => new Set());
  const [happy, setHappy] = useState<{ botId: string; until: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [panelHeight, setPanelHeight] = useState(0);
  const [lookX, setLookX] = useState<number | null>(null);
  const [dropBot, setDropBot] = useState<string | null>(null);
  const [heldMoment, setHeldMoment] = useState<NotchMoment | null>(null);
  const presented = useRef(new Set<string>());
  const typing = useRef(false);

  useEffect(() => {
    if (!bridge) return;
    const offs = [
      bridge.onGeometry(setGeometry),
      bridge.onSnapshot((next) => setSnap(next ?? EMPTY)),
      bridge.onPointer((pointer) => {
        if (pointer.phase !== "enter") return;
        if (pointer.kind === "drag") setDrag(true);
        setHover(true);
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [bridge]);

  // an answer leaves the notch at once; the next snapshot has the truth
  const asks = useMemo(() => snap.asks.filter((ask) => !answered.has(ask.id)), [snap.asks, answered]);
  useEffect(() => {
    if (!answered.size) return;
    const live = new Set(snap.asks.map((ask) => ask.id));
    if ([...answered].some((id) => !live.has(id))) setAnswered((current) => new Set([...current].filter((id) => live.has(id))));
  }, [snap.asks, answered]);
  // an ask that left is forgotten; ids name one request, so it never returns
  useEffect(() => {
    const live = new Set(snap.asks.map((ask) => ask.id));
    for (const id of presented.current) if (!live.has(id)) presented.current.delete(id);
  }, [snap.asks]);

  // one ask climbs out at a time, each once, oldest first
  const card = cardId ? asks.find((ask) => ask.id === cardId) ?? null : null;
  useEffect(() => {
    if (cardId && !card) setCardId(null);
    if (card) return;
    const next = asks.find((ask) => !presented.current.has(ask.id));
    if (!next) return;
    presented.current.add(next.id);
    setCardId(next.id);
  }, [asks, card, cardId]);
  useEffect(() => {
    if (!card || hover || typing.current) return;
    const timer = window.setTimeout(() => setCardId(null), CARD_MS);
    return () => window.clearTimeout(timer);
  }, [card, hover]);

  const fullscreen = geometry?.fullscreen === true;
  const freshMoment = useMemo<NotchMoment | null>(() => {
    const fresh = snap.moments.filter((candidate) => candidate.at > now - MOMENT_MS);
    return fresh.length ? fresh.reduce((a, b) => (b.at > a.at ? b : a)) : null;
  }, [snap.moments, now]);
  // a moment under the pointer stays until the pointer leaves, so reaching
  // for it never ends with a click on whatever replaced it; the copy held
  // takes the reply's text as it lands
  const moment = heldMoment ? snap.moments.find((candidate) => candidate.id === heldMoment.id) ?? heldMoment : fullscreen ? null : freshMoment;
  // wake when a moment or a happy face should end
  useEffect(() => {
    const ends = [
      ...snap.moments.map((candidate) => candidate.at + MOMENT_MS),
      ...(happy ? [happy.until] : []),
    ].filter((at) => at > Date.now());
    if (!ends.length) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(30, Math.min(...ends) - Date.now() + 20));
    return () => window.clearTimeout(timer);
  }, [snap.moments, happy, now]);
  useEffect(() => setNow(Date.now()), [snap.moments]);

  // full screen: only a bot waiting on the person may show
  const live = (snap.working.length > 0 && !fullscreen) || asks.length > 0;
  const notchMode = geometry?.mode === "notch";
  const mode: Mode = drag || shelf
    ? "shelf"
    : card
      ? "card"
      : moment
        ? "moment"
        : live
          ? "peek"
          : notchMode ? "rest" : "hidden";

  // the elapsed times in the shelf move only while it is open
  useEffect(() => {
    if (mode !== "shelf") return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(timer);
  }, [mode]);

  const look = (id: string): Look | null => snap.bots[id] ?? snap.shelf.find((bot) => bot.id === id) ?? null;
  const happyBot = happy && happy.until > now ? happy.botId : null;
  const heads = useMemo<Head[]>(() => {
    const list: Head[] = [];
    const add = (id: string, face: GlyphFaceState, threadId: string) => {
      if (list.some((head) => head.id === id)) return;
      const bot = snap.bots[id] ?? snap.shelf.find((candidate) => candidate.id === id);
      if (bot) list.push({ id, name: bot.name, color: bot.color, body: bot.body, face, threadId });
    };
    if (mode === "moment" && moment) add(moment.botId, moment.kind === "done" ? "finished" : "failed", moment.threadId);
    if (card) add(card.botId, "waiting", card.threadId);
    // the happy face opens the thread its row opens
    if (happyBot) add(happyBot, "happy", snap.shelf.find((bot) => bot.id === happyBot)?.threadId ?? "");
    for (const ask of asks) add(ask.botId, "waiting", ask.threadId);
    if (!fullscreen) for (const bot of snap.working) add(bot.id, faceFor(bot.state), bot.threadId);
    return list;
  }, [snap, asks, card, moment, mode, happyBot, fullscreen]);

  // ---- geometry -----------------------------------------------------------
  const win = geometry?.window ?? { width: 760, height: 520 };
  const cx = win.width / 2;
  const nw = notchMode ? geometry?.notch.width ?? 0 : 0;
  // the pill stays inside the menu bar, its faces sized to fit it: hanging
  // below the bar covered the top of whatever window sat under it
  const band = notchMode ? Math.max(20, geometry?.notch.height || geometry?.menuBar || 32) : Math.max(18, geometry?.menuBar || 24);
  const headSize = notchMode ? HEAD : Math.max(14, Math.min(HEAD, band - 6));
  const step = Math.round(headSize * (STEP / HEAD));
  const gap = notchMode ? PAD : 6;
  const shown = heads.slice(0, MAX_HEADS);
  const overflow = heads.length - shown.length;
  const waitingDot = asks.length > 0 && mode !== "card";
  const leftWing = shown.length ? gap + headSize + (shown.length - 1) * step + PAD : 0;
  const rightWing = overflow > 0 ? gap + 24 + PAD : waitingDot ? gap + 8 + PAD : 0;
  const wing = Math.max(leftWing, rightWing, shown.length ? 34 : 0);
  // with no notch to flank, the heads and their count sit as one centred row
  const headsSpan = shown.length ? headSize + (shown.length - 1) * step : 0;
  const extraSpan = overflow > 0 ? 20 : waitingDot ? 8 : 0;
  const pillRow = headsSpan + (headsSpan && extraSpan ? 6 : 0) + extraSpan;
  const pillStart = cx - pillRow / 2;
  const headX = (index: number) => notchMode ? cx - nw / 2 - gap - headSize - index * step : pillStart + headsSpan - headSize - index * step;
  const extraLeft = notchMode ? cx + nw / 2 + gap : pillStart + headsSpan + (headsSpan ? 6 : 0);
  const peekWidth = notchMode ? nw + wing * 2 : pillRow ? pillRow + 2 * 10 : 0;
  const openWidth = Math.min(Math.max(peekWidth, OPEN_WIDTH), win.width - 24);
  const peekRadius = notchMode ? Math.min(band / 2 - 3, 11) : Math.min(band / 2 - 2, 9);

  const target = useMemo(() => {
    switch (mode) {
      case "hidden": return { width: 0, height: band, radius: peekRadius, sensor: false };
      case "rest": return { width: nw, height: band, radius: Math.min(peekRadius, 9), sensor: true };
      case "peek": return { width: peekWidth, height: band, radius: peekRadius, sensor: true };
      case "moment": return { width: Math.max(peekWidth, MOMENT_WIDTH), height: band + panelHeight, radius: 18, sensor: true };
      case "card":
      case "shelf": return { width: openWidth, height: Math.min(band + panelHeight, win.height - 16), radius: 22, sensor: true };
    }
  }, [mode, band, nw, peekWidth, openWidth, panelHeight, peekRadius, win.height]);

  // ---- the shape, on springs ---------------------------------------------
  const shapeRef = useRef<SVGPathElement>(null);
  const clipRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const springs = useRef<{ width: Spring; height: Spring; radius: Spring } | null>(null);
  const frame = useRef(0);
  const drawn = useRef({ width: 0, height: 0 });
  const visible = mode !== "rest" && mode !== "hidden";
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  const draw = useCallback(() => {
    const s = springs.current;
    if (!s) return;
    const d = notchPath(cx, s.width.value, s.height.value, s.radius.value, EAR);
    shapeRef.current?.setAttribute("d", d);
    if (clipRef.current) clipRef.current.style.clipPath = `path("${d}")`;
    drawn.current = { width: s.width.value, height: s.height.value };
    const moving = s.width.moving || s.height.moving || s.radius.moving;
    // at rest the hardware notch is the shape; drawing over it would only
    // show where the two differ
    if (rootRef.current) rootRef.current.dataset.off = !visibleRef.current && !moving ? "1" : "";
    return moving;
  }, [cx]);

  useLayoutEffect(() => {
    if (!geometry) return;
    if (!springs.current) {
      springs.current = {
        width: new Spring(notchMode ? nw : 0),
        height: new Spring(band),
        radius: new Spring(Math.min(peekRadius, 9)),
      };
    }
    const s = springs.current;
    const growing = target.width >= s.width.target && target.height >= s.height.target;
    const config = growing ? SHAPE_SPRING : FOLD_SPRING;
    s.width.set(target.width, config);
    s.height.set(target.height, config);
    s.radius.set(target.radius, config);
    if (reduced) {
      s.width.jump(target.width);
      s.height.jump(target.height);
      s.radius.jump(target.radius);
    }
    if (frame.current) return;
    let last = performance.now();
    const tick = (time: number) => {
      const dt = (time - last) / 1000;
      last = time;
      const a = s.width.step(dt);
      const b = s.height.step(dt);
      const c = s.radius.step(dt);
      draw();
      frame.current = a || b || c ? requestAnimationFrame(tick) : 0;
    };
    draw();
    if (s.width.moving || s.height.moving || s.radius.moving) frame.current = requestAnimationFrame(tick);
  }, [geometry, target, reduced, draw, notchMode, nw, band, peekRadius]);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  // the native sensor follows what is drawn, so hovering it opens the shelf
  useEffect(() => {
    if (!bridge || !geometry) return;
    if (!target.sensor || target.width < 1) bridge.setShape(0, 0);
    else bridge.setShape(Math.ceil(target.width + EAR * 2), Math.ceil(target.height));
  }, [bridge, geometry, target]);

  // ---- pointer ------------------------------------------------------------
  const dwell = useRef(0);
  const grace = useRef(0);
  const sawMove = useRef(false);
  const watchdog = useRef(0);

  const fold = useCallback(() => {
    window.clearTimeout(dwell.current);
    window.clearTimeout(grace.current);
    setHover(false);
    setShelf(false);
    setDrag(false);
    setDropBot(null);
    setLookX(null);
    setHeldMoment(null);
    typing.current = false;
    bridge?.setInteractive(false);
  }, [bridge]);

  const leave = useCallback(() => {
    window.clearTimeout(dwell.current);
    // click-through straight away, so the pointer never meets a dead area
    bridge?.setInteractive(false);
    window.clearTimeout(grace.current);
    grace.current = window.setTimeout(() => {
      setHover(false);
      setShelf(false);
      setDrag(false);
      setDropBot(null);
      setLookX(null);
      setHeldMoment(null);
    }, LEAVE_GRACE_MS);
  }, [bridge]);

  useEffect(() => {
    if (!hover) return;
    window.clearTimeout(grace.current);
    sawMove.current = false;
    // the pointer may have passed straight over: no move means it left
    window.clearTimeout(watchdog.current);
    watchdog.current = window.setTimeout(() => {
      if (!sawMove.current) leave();
    }, 700);
    // at rest a pass over the camera is not a request: a click opens the
    // shelf. A card or a moment is read where it is, not swapped for it.
    if (mode !== "peek" || drag) return () => window.clearTimeout(watchdog.current);
    window.clearTimeout(dwell.current);
    dwell.current = window.setTimeout(() => setShelf(true), DWELL_MS);
    return () => {
      window.clearTimeout(dwell.current);
      window.clearTimeout(watchdog.current);
    };
    // only a fresh hover starts the dwell
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hover]);

  const inside = useCallback((x: number, y: number) => {
    const { width, height } = drawn.current;
    return Math.abs(x - cx) <= width / 2 + EAR + 6 && y <= height + 6;
  }, [cx]);

  // the moment the pointer reached stays put until the pointer leaves
  useEffect(() => {
    if (hover && mode === "moment" && moment && heldMoment?.id !== moment.id) setHeldMoment(moment);
  }, [hover, mode, moment, heldMoment]);

  // at rest the root is hidden (the hardware notch is the shape), so the
  // click is heard on the window, not the root
  useEffect(() => {
    if (mode !== "rest") return;
    const onDown = (event: MouseEvent) => {
      if (inside(event.clientX, event.clientY)) setShelf(true);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [mode, inside]);

  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      sawMove.current = true;
      if (!inside(event.clientX, event.clientY)) leave();
    };
    const onOut = (event: MouseEvent) => {
      if (!event.relatedTarget) leave();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (card) setCardId(null);
        fold();
      }
    };
    window.addEventListener("mousemove", onMove);
    document.addEventListener("mouseout", onOut);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseout", onOut);
      window.removeEventListener("keydown", onKey);
    };
  }, [inside, leave, fold, card]);

  // ---- files dragged onto a bot ------------------------------------------
  const onDragOver = (event: DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    sawMove.current = true;
    if (!drag) setDrag(true);
    if (!inside(event.clientX, event.clientY)) return leave();
    const row = (event.target as HTMLElement).closest?.("[data-drop-bot]") as HTMLElement | null;
    setDropBot(row?.dataset.dropBot ?? null);
    setLookX(event.clientX);
  };
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    const row = (event.target as HTMLElement).closest?.("[data-drop-bot]") as HTMLElement | null;
    const botId = row?.dataset.dropBot;
    const threadId = row?.dataset.dropThread;
    if (bridge && botId && threadId && bridge.drop(botId, threadId, Array.from(event.dataTransfer.files)) > 0) {
      setHappy({ botId, until: Date.now() + HAPPY_MS });
    }
    fold();
  };
  const onDragLeave = (event: DragEvent) => {
    if (!event.relatedTarget) leave();
  };

  // ---- actions -----------------------------------------------------------
  const open = (botId: string, threadId: string) => {
    if (!bridge || !threadId) return;
    bridge.act({ type: "open", botId, threadId });
    fold();
  };
  const answer = (ask: NotchAsk, value: NotchAnswer) => {
    if (!bridge || answered.has(ask.id)) return;
    bridge.act({ type: "answer", askId: ask.id, answer: value });
    setAnswered((current) => new Set([...current, ask.id]));
    if (!("behavior" in value) || value.behavior === "allow") setHappy({ botId: ask.botId, until: Date.now() + HAPPY_MS });
    if (cardId === ask.id) setCardId(null);
    typing.current = false;
    if (mode === "card") fold();
  };
  const onTyping = (active: boolean) => {
    typing.current = active;
    if (active) bridge?.setInteractive("keys");
  };
  const ask = (botId: string, threadId: string, text: string) => {
    if (!bridge || !threadId || !text.trim()) return;
    bridge.act({ type: "ask", botId, threadId, text: text.trim() });
    setHappy({ botId, until: Date.now() + HAPPY_MS });
    fold();
  };

  // ---- panel content, measured so the shape fits it -----------------------
  // a callback ref: the panel only mounts once geometry has arrived
  const observer = useRef<ResizeObserver | null>(null);
  const panelRef = useCallback((element: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!element) return;
    const measure = () => setPanelHeight(Math.ceil(element.getBoundingClientRect().height));
    measure();
    observer.current = new ResizeObserver(measure);
    observer.current.observe(element);
  }, []);

  const momentBot = moment ? look(moment.botId) : null;
  const shelfRows = snap.shelf.slice(0, MAX_ROWS);
  const panelWidth = mode === "moment" ? Math.max(peekWidth, MOMENT_WIDTH) : openWidth;
  let panel: ReactNode = null;
  if (mode === "card" && card) {
    const bot = look(card.botId);
    panel = <AskCard key={card.id} ask={card} bot={bot} climbed onAnswer={answer} onOpen={open} onTyping={onTyping} />;
  } else if (mode === "moment" && moment && momentBot) {
    panel = <MomentLine key={moment.id} moment={moment} bot={momentBot} onOpen={open} />;
  } else if (mode === "shelf") {
    panel = (
      <div key="shelf" className="notch-shelf">
        {drag && <div className="notch-hint">drop on a bot to hand it the file</div>}
        {!drag && asks.slice(0, MAX_SHELF_ASKS).map((ask) => (
          <AskCard key={ask.id} ask={ask} bot={look(ask.botId)} onAnswer={answer} onOpen={open} onTyping={onTyping} />
        ))}
        {!drag && !asks.length && shelfRows.length > 0 && <QuickAsk rows={shelfRows} onSend={ask} onTyping={onTyping} />}
        {!drag && asks.length > MAX_SHELF_ASKS && (
          <button type="button" className="notch-more" onClick={() => open(asks[MAX_SHELF_ASKS]!.botId, asks[MAX_SHELF_ASKS]!.threadId)}>
            {asks.length - MAX_SHELF_ASKS} more waiting
          </button>
        )}
        {shelfRows.map((bot) => (
          <ShelfRow key={bot.id} bot={bot} now={now} drop={drag} target={dropBot === bot.id}
            look={lookX === null ? 0 : (lookX - cx) / 160} onOpen={open} reduced={reduced}
            asking={asks.some((ask) => ask.botId === bot.id)} />
        ))}
        {!shelfRows.length && <div className="notch-hint">no bots yet</div>}
      </div>
    );
  }

  // ---- heads in the band ---------------------------------------------------
  const headTop = Math.round((band - headSize) / 2) + (notchMode ? 1 : 0);
  const cardLeft = cx - openWidth / 2 + 16;
  const failedEdge = mode === "moment" && moment?.kind === "failed";

  if (!bridge || !geometry) return null;
  return (
    <div ref={rootRef} className="notch-root" data-reduced={reduced ? "1" : ""} data-mode={mode}
      onDragOver={onDragOver} onDrop={onDrop} onDragLeave={onDragLeave}>
      <svg className="notch-shape" width={win.width} height={win.height} aria-hidden="true">
        <path ref={shapeRef} className={failedEdge ? "notch-fill notch-failed" : "notch-fill"} />
      </svg>
      <div ref={clipRef} className="notch-clip">
        {shown.map((head, index) => {
          const climbed = mode === "card" && card?.botId === head.id;
          const x = climbed ? cardLeft : headX(index);
          const y = climbed ? band + 12 : headTop;
          const scale = climbed ? CLIMBED / HEAD : headSize / HEAD;
          const style: CSSProperties = { transform: `translate(${x}px, ${y}px) scale(${scale})`, zIndex: 10 - index };
          const gesture = head.face === "finished" || head.face === "happy" ? "hop" : head.face === "failed" ? "shake" : climbed ? "climb" : "";
          // a working face holds still; only one that needs the person blinks
          const needs = head.face === "waiting";
          return (
            <button type="button" key={head.id} className="notch-head" style={style} title={head.name}
              onClick={() => open(head.id, head.threadId)} tabIndex={-1}>
              <span key={`${head.face}-${gesture}`} className={gesture && !reduced ? `notch-gesture-${gesture}` : undefined}>
                <NotchMascot color={head.color} body={head.body} face={head.face} size={HEAD}
                  pixels={head.face === "finished" ? 26 : climbed ? CLIMBED : HEAD}
                  look={lookX === null ? 0 : (lookX - (x + HEAD / 2)) / 120}
                  animated={!reduced} blink={needs && !drag} />
              </span>
            </button>
          );
        })}
        {overflow > 0 && (
          <button type="button" className="notch-overflow" style={{ left: extraLeft, top: 0, height: band }} tabIndex={-1}
            onClick={() => setShelf(true)}>+{overflow}</button>
        )}
        {overflow === 0 && waitingDot && (
          <button type="button" key={asks[0]!.id} className="notch-dot" title="needs you" tabIndex={-1}
            onClick={() => setCardId(asks[0]!.id)}
            style={{ left: extraLeft - 4, top: band / 2 - 8, ["--dot" as string]: dotColor(look(asks[0]!.botId)?.color) }} />
        )}
        <div ref={panelRef} className="notch-panel" style={{ left: cx - panelWidth / 2, top: band, width: panelWidth }}>
          {panel}
        </div>
      </div>
    </div>
  );
}

const dotColor = (color: string | undefined) => (color ? resolveMausColor(color) : "#FFFFFF");

function AskCard({ ask, bot, climbed = false, onAnswer, onOpen, onTyping }: {
  ask: NotchAsk;
  bot: Look | null;
  climbed?: boolean;
  onAnswer: (ask: NotchAsk, answer: NotchAnswer) => void;
  onOpen: (botId: string, threadId: string) => void;
  onTyping: (active: boolean) => void;
}) {
  const [text, setText] = useState("");
  const send = () => {
    const value = text.trim();
    if (value) onAnswer(ask, { text: value });
  };
  return (
    <div className={climbed ? "notch-ask notch-enter" : "notch-ask notch-ask-inline notch-enter"}>
      <div className="notch-ask-top">
        {!climbed && bot && (
          <span className="notch-ask-face">
            <NotchMascot color={bot.color} body={bot.body} face="waiting" size={28} pixels={28} />
          </span>
        )}
        <div className="notch-ask-meta">
          <span className="notch-name">{bot?.name ?? "a bot"}</span>
          <span className="notch-sub">{ask.kind === "approval" ? "wants to go ahead" : "has a question"}{ask.title ? ` · ${ask.title}` : ""}</span>
        </div>
      </div>
      {ask.preview && <p className="notch-ask-text">{ask.preview}</p>}
      <div className="notch-actions">
        <button type="button" className="notch-link" onClick={() => onOpen(ask.botId, ask.threadId)}>open</button>
        <span className="notch-spacer" />
        {ask.kind === "approval" && (
          <>
            <button type="button" className="notch-button" onClick={() => onAnswer(ask, { behavior: "deny" })}>deny</button>
            <button type="button" className="notch-button notch-primary" onClick={() => onAnswer(ask, { behavior: "allow" })}>allow</button>
          </>
        )}
        {ask.kind === "question" && ask.options?.map((option, index) => (
          <button type="button" key={index} className="notch-button notch-option" title={option.value}
            onClick={() => onAnswer(ask, { option: option.value })}>{option.label}</button>
        ))}
      </div>
      {ask.kind === "question" && ask.freeText && (
        <form className="notch-reply" onSubmit={(event) => { event.preventDefault(); send(); }}>
          <input value={text} placeholder="answer…" maxLength={4000} spellCheck={false}
            onChange={(event) => setText(event.target.value)}
            onFocus={() => onTyping(true)} onBlur={() => onTyping(Boolean(text))}
            onMouseDown={() => onTyping(true)} />
          <button type="submit" className="notch-button notch-primary" disabled={!text.trim()}>send</button>
        </form>
      )}
    </div>
  );
}

function MomentLine({ moment, bot, onOpen }: { moment: NotchMoment; bot: Look; onOpen: (botId: string, threadId: string) => void }) {
  return (
    <button type="button" className={`notch-moment notch-enter notch-moment-${moment.kind}`} onClick={() => onOpen(moment.botId, moment.threadId)}>
      <span className="notch-moment-top">
        <span className="notch-name">{bot.name}</span>
        <span className="notch-moment-word">{moment.kind === "done" ? "finished" : "hit a problem"}</span>
        {moment.title && <span className="notch-sub notch-moment-title">{moment.title}</span>}
      </span>
      {moment.preview && <span className="notch-moment-preview">{moment.preview}</span>}
    </button>
  );
}

function ShelfRow({ bot, now, drop, target, look, onOpen, reduced, asking }: {
  bot: NotchBot;
  now: number;
  drop: boolean;
  target: boolean;
  look: number;
  onOpen: (botId: string, threadId: string) => void;
  reduced: boolean;
  asking: boolean;
}) {
  const resting = bot.state === "idle" || bot.state === "stopped";
  const face = asking ? "waiting" : faceFor(bot.state);
  const word = asking ? "needs you" : STATE_WORD[bot.state];
  return (
    <button type="button" className={`notch-row notch-enter${resting ? " notch-row-rest" : ""}${target ? " notch-row-target" : ""}`}
      data-drop-bot={bot.id} data-drop-thread={bot.threadId} onClick={() => onOpen(bot.id, bot.threadId)}
      style={target ? ({ ["--row" as string]: dotColor(bot.color) } as CSSProperties) : undefined}>
      <span className={target && !reduced ? "notch-row-face notch-gesture-hop" : "notch-row-face"}>
        <NotchMascot color={bot.color} body={bot.body} face={target ? "happy" : face} size={26} pixels={26}
          look={drop ? look : 0} animated={!reduced} />
      </span>
      <span className="notch-row-text">
        <span className="notch-name">{bot.name}</span>
        {bot.title && <span className="notch-sub">{bot.title}</span>}
      </span>
      {!drop && word && (
        <span className={asking ? "notch-state notch-state-ask" : "notch-state"}>
          {word}{!resting && !asking && bot.since ? ` ${elapsed(bot.since, now)}` : ""}
        </span>
      )}
    </button>
  );
}

/** A line for a new message to any bot on the shelf, into the thread its row
 * opens; the chip picks the bot. The app stays where the person left it. */
function QuickAsk({ rows, onSend, onTyping }: {
  rows: readonly NotchBot[];
  onSend: (botId: string, threadId: string, text: string) => void;
  onTyping: (active: boolean) => void;
}) {
  const [index, setIndex] = useState(0);
  const [text, setText] = useState("");
  const bot = rows[index % rows.length]!;
  return (
    <form className="notch-quick" onSubmit={(event) => {
      event.preventDefault();
      onSend(bot.id, bot.threadId, text);
    }}>
      <button type="button" className="notch-chip" title="ask another bot"
        style={{ ["--row" as string]: dotColor(bot.color) } as CSSProperties}
        onClick={() => setIndex((value) => (value + 1) % rows.length)}>
        <NotchMascot color={bot.color} body={bot.body} face="idle" size={16} pixels={16} animated={false} />
        <span>{bot.name}</span>
      </button>
      <input value={text} placeholder={`ask ${bot.name}…`} maxLength={4000} aria-label={`ask ${bot.name}`}
        onChange={(event) => setText(event.target.value)}
        onFocus={() => onTyping(true)} onBlur={() => onTyping(Boolean(text))}
        onMouseDown={() => onTyping(true)} />
    </form>
  );
}
