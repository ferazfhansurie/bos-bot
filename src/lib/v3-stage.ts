// 3.0: where each bot's mascot stands right now. A bot lives in its sidebar
// row; while it works on the open thread it stands in the composer island,
// walks into a tab header when it opens one, and comes forward to point when
// it needs the person. Moving between spots is one shared-element View
// Transition: only the travelling mascot carries a view-transition-name, the
// rest of the page is not cross-faded, and the overlay never takes a click.
//
// One face per bot on screen: wherever the spot is, every other place that
// could show the bot keeps an empty seat. An empty thread holds it big above
// the composer ("empty"); otherwise a resting bot sits in its row.
//
// Reduced motion, a missing API, or the "keep bots in place" switch set the
// spot instantly; a move asked for while another trip is in the air waits for
// it and then walks. A bot whose chat closes under it (another bot opened)
// walks home as a ghost above the page (walkingHome), so the sidebar's
// scroller can't clip it. Nothing here runs unless a v3 surface calls it.
import { useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { SPRINGS, TRAVEL, settleMs, springCss } from "../../shared/mascot-motion";

export type Spot = "sidebar" | "empty" | "island" | "tab" | "pointing";

/** The one name a travelling mascot wears; one trip at a time. */
export const TRAVEL_NAME = "v3-mascot";

const spots = new Map<string, Spot>();
const done = new Set<string>();
let travelling: string | null = null;
/** the newest move asked for while a trip was in the air, per bot */
const queued = new Map<string, Spot>();
let version = 0;
const listeners = new Set<() => void>();

function emit() {
  version += 1;
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
const snapshot = () => version;

export function spotOf(botId: string): Spot {
  return spots.get(botId) ?? "sidebar";
}

function reduced(): boolean {
  return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/** Motion allowed at all: not reduced, not kept in place, page visible. */
function canMove(): boolean {
  return typeof document !== "undefined" && !reduced() && !keepInPlace() && !document.hidden;
}

/** The "keep bots in place" switch: travel off, spots still change. */
export function keepInPlace(): boolean {
  try {
    return localStorage.getItem("bos-v3-keep-in-place") === "1";
  } catch {
    return false;
  }
}

let styleReady = false;
function ensureStyle() {
  if (styleReady || typeof document === "undefined") return;
  styleReady = true;
  const travel = SPRINGS.travel;
  const style = document.createElement("style");
  style.dataset.v3Stage = "";
  // root stays put (no page cross-fade); only the mascot group moves, on the
  // travel spring, with a small lift so the hop reads as an arc
  style.textContent = `
html.v3-travel::view-transition { pointer-events: none; }
html.v3-travel::view-transition-old(root) { display: none; }
html.v3-travel::view-transition-new(root) { animation: none; }
html.v3-travel::view-transition-group(${TRAVEL_NAME}) {
  animation-duration: ${settleMs(travel)}ms;
  animation-timing-function: ${springCss(travel)};
  z-index: 60;
}
html.v3-travel::view-transition-image-pair(${TRAVEL_NAME}) {
  animation: v3-travel-arc ${settleMs(travel)}ms ${springCss(SPRINGS.glide)} both;
}
html.v3-travel::view-transition-old(${TRAVEL_NAME}),
html.v3-travel::view-transition-new(${TRAVEL_NAME}) {
  animation-duration: ${Math.round(settleMs(travel) * 0.5)}ms;
  mix-blend-mode: normal;
}
@keyframes v3-travel-arc {
  0% { transform: translateY(0) scale(1, 1); }
  45% { transform: translateY(calc(-1 * var(--v3-arc, ${TRAVEL.arcMaxPx * 0.5}px))) scale(1, 1); }
  85% { transform: translateY(0) scale(1.06, ${TRAVEL.landSquash}); }
  100% { transform: none; }
}`;
  document.head.appendChild(style);
}

/** Move a bot's mascot to a spot, hopping there when motion is allowed. */
export function travelTo(botId: string, to: Spot): void {
  queued.delete(botId);
  if (to !== "sidebar" && walking.delete(botId)) emit();
  const from = spotOf(botId);
  if (from === to) return;
  const set = () => {
    if (to === "sidebar") spots.delete(botId);
    else spots.set(botId, to);
    emit();
  };
  const canTravel = canMove() && typeof document.startViewTransition === "function";
  if (!canTravel) {
    set();
    return;
  }
  if (travelling !== null) {
    // one trip at a time: this one walks when the current one lands
    queued.set(botId, to);
    return;
  }
  ensureStyle();
  const root = document.documentElement;
  // name the mascot where it stands now, then let the browser snapshot it
  flushSync(() => {
    travelling = botId;
    emit();
  });
  root.classList.add("v3-travel");
  let transition: ViewTransition;
  try {
    transition = document.startViewTransition(() => flushSync(set));
  } catch {
    travelling = null;
    root.classList.remove("v3-travel");
    set();
    return;
  }
  void transition.finished.finally(() => {
    travelling = null;
    root.classList.remove("v3-travel");
    noteFaces();
    emit();
    const next = queued.entries().next().value;
    if (next) travelTo(next[0], next[1]);
  });
}

// ── walking home when the chat closes under a bot ──────────────────────────

const faceRects = new Map<string, { left: number; top: number; width: number; height: number }>();
const walking = new Map<string, { left: number; top: number; width: number; height: number }>();
let watching = false;

/** Where each out-of-row face stands right now ([data-v3-face] slots). Read
 * on the person's own input, before a click or key can switch the chat. */
export function noteFaces(): void {
  if (typeof document === "undefined") return;
  for (const el of document.querySelectorAll<HTMLElement>("[data-v3-face]")) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && el.dataset.v3Face) faceRects.set(el.dataset.v3Face, { left: r.left, top: r.top, width: r.width, height: r.height });
  }
}

function watchFaces() {
  if (watching || typeof document === "undefined" || typeof document.addEventListener !== "function") return;
  watching = true;
  document.addEventListener("pointerdown", noteFaces, { capture: true, passive: true });
  document.addEventListener("keydown", noteFaces, { capture: true, passive: true });
}

/** The rect a bot walks home from, while it walks. */
export function walkingHome(botId: string): { left: number; top: number; width: number; height: number } | undefined {
  return walking.get(botId);
}

export function walkingHomeIds(): string[] {
  return [...walking.keys()];
}

/** The ghost reached the row: the row shows the face again. */
export function arrivedHome(botId: string): void {
  if (!walking.delete(botId)) return;
  emit();
}

/** The thread closed under the bot (another bot opened, the chat left):
 * home, walking from where it last stood when motion is allowed. */
export function resetSpot(botId: string): void {
  queued.delete(botId);
  if (!spots.has(botId)) return;
  spots.delete(botId);
  const from = faceRects.get(botId);
  if (from && canMove()) walking.set(botId, from);
  emit();
}

const tabSlots = new Map<string, number>();

/** A tab header the bot is working in can hold its mascot; returns the release. */
export function registerTabSlot(botId: string): () => void {
  tabSlots.set(botId, (tabSlots.get(botId) ?? 0) + 1);
  emit();
  return () => {
    const n = (tabSlots.get(botId) ?? 1) - 1;
    if (n <= 0) tabSlots.delete(botId);
    else tabSlots.set(botId, n);
    emit();
  };
}

export function hasTabSlot(botId: string): boolean {
  return (tabSlots.get(botId) ?? 0) > 0;
}

const opened = new Map<string, string>();

/** The workspace tab a bot opened (open_tab, desk_open) during its turn; its
 * header holds the mascot until the turn ends. */
export function markOpened(botId: string, tabId: string): void {
  if (opened.get(botId) === tabId) return;
  opened.set(botId, tabId);
  emit();
}

export function openedTab(botId: string): string | undefined {
  return opened.get(botId);
}

export function clearOpened(botId: string): void {
  if (!opened.delete(botId)) return;
  emit();
}

export function markDone(botId: string): void {
  if (done.has(botId)) return;
  done.add(botId);
  emit();
}

export function clearDone(botId: string): void {
  if (!done.delete(botId)) return;
  emit();
}

/** The spot, whether this bot's mascot carries the travel name, and its done dot. */
export function useStage(botId: string): { spot: Spot; travelling: boolean; done: boolean; tab: boolean; opened?: string; walking: boolean } {
  useSyncExternalStore(subscribe, snapshot, snapshot);
  watchFaces();
  return { spot: spotOf(botId), travelling: travelling === botId, done: done.has(botId), tab: hasTabSlot(botId), opened: openedTab(botId), walking: walking.has(botId) };
}

/** Re-render on any stage change (the walk-home layer). */
export function useStageVersion(): number {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Where a bot's one face is drawn, given the spot: exactly one place, and
 * none while it walks home above the page. */
export function faceHere(stage: { spot: Spot; walking?: boolean }, here: Spot): boolean {
  return stage.spot === here && !(here === "sidebar" && stage.walking);
}

/** The style that names a mascot slot while its bot travels from or to it. */
export function travelName(stage: { spot: Spot; travelling: boolean }, here: Spot): { viewTransitionName?: string } | undefined {
  return stage.travelling && stage.spot === here ? { viewTransitionName: TRAVEL_NAME } : undefined;
}

/** test seam */
export function __noteFace(botId: string, rect: { left: number; top: number; width: number; height: number }): void {
  faceRects.set(botId, rect);
}

export function __resetStage(): void {
  spots.clear();
  done.clear();
  tabSlots.clear();
  opened.clear();
  queued.clear();
  faceRects.clear();
  walking.clear();
  travelling = null;
  emit();
}
