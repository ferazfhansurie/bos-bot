// 3.0: the first run is the bot showing you, not a tour. Its greeting types
// itself out, then it opens the + menu and points at attach; the first time
// it needs an app it points at connect. After that, the first time any card
// or screen with a primary button appears, the bot nods at that button once.
// Every step is shown once on this computer (lib/v3-seen).
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ActivityMascot } from "../ActivityMascot";
import { ChatMarkdown } from "../ChatMarkdown";
import { t } from "@/lib/i18n";
import { useV3 } from "@/lib/v3";
import { markSeen, seen, useSeen } from "@/lib/v3-seen";
import { useStore, type Bot, type Message } from "@/state/store";
import "./alive.css";

/** A greeting this old is history, not a first run: show it as is. */
const FRESH_MS = 3 * 60_000;
/** Typing speed, capped so a long greeting still lands in under 3s. */
const CHAR_MS = 22;
const MAX_TYPE_MS = 2600;

function reduced(): boolean {
  return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

export function isGreeting(message: Message): boolean {
  return message.onboarding?.card?.kind === "suggestions";
}

/** The onboarding greeting: typed out once, its starter jobs after it. */
export function OnboardingGreeting({ bot, message, children }: { bot: Bot; message: Message; children: ReactNode }) {
  const v3 = useV3();
  const key = `greet:${message.id}`;
  const done = useSeen(key);
  const text = message.text ?? "";
  const fresh = Date.now() - message.at < FRESH_MS;
  const typing = v3 && !done && fresh && text.length > 0 && !reduced();
  const [shown, setShown] = useState(0);
  useEffect(() => {
    if (!v3 || done) return;
    if (!typing) {
      // old or motion-reduced: nothing to type, but the first-run steps still follow a fresh one
      if (fresh && text) markSeen("teach:greeted");
      markSeen(key);
      return;
    }
    const step = Math.max(8, Math.min(CHAR_MS, MAX_TYPE_MS / text.length));
    const started = performance.now();
    let frame = 0;
    const tick = () => {
      const count = Math.min(text.length, Math.floor((performance.now() - started) / step));
      setShown(count);
      if (count >= text.length) {
        markSeen("teach:greeted");
        markSeen(key);
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [v3, done, typing, fresh, text, key]);
  if (!typing) return <>{children}</>;
  // cut at a word edge so half-words never flash
  const cut = text.slice(0, Math.max(0, text.lastIndexOf(" ", shown)));
  return (
    <div className="flex w-full min-w-0 flex-col items-start" data-testid="v3-typing" aria-live="polite">
      <div className="w-full min-w-0 text-ink">
        <ChatMarkdown text={cut || "​"} message={{ threadId: bot.threadId, messageId: message.id }} />
      </div>
    </div>
  );
}

export type TeachStep = { key: string; selector: string; caption: string };

function connectorWaiting(messages: Message[]): boolean {
  return messages.some((m) => m.kind === "connector" && m.connector && !m.connector.dismissed && m.connector.status !== "connected");
}

/** The first-run step the bot is showing in this thread, if any. */
export function useTeach(active: boolean, bot: Bot): { teach: TeachStep | null; dismiss: () => void } {
  useSeen("teach:greeted");
  const connect = active && connectorWaiting(bot.messages) && !seen("teach:connect");
  const attach = active && !bot.busy && seen("teach:greeted") && !seen("teach:attach") && bot.messages.some(isGreeting);
  const teach: TeachStep | null = useMemo(() => (
    connect ? { key: "teach:connect", selector: '[data-v3-point="connect"]', caption: t("v3.teach.connect") }
      : attach ? { key: "teach:attach", selector: '[data-v3-teach="attach"]', caption: t("v3.teach.attach") }
      : null
  ), [connect, attach]);
  const key = teach?.key;
  const dismiss = useCallback(() => {
    if (key) markSeen(key);
  }, [key]);

  // attach lives in the + menu: open it so the bot can point inside
  useEffect(() => {
    if (key !== "teach:attach") return;
    const timer = setTimeout(() => {
      const menu = Array.from(document.querySelectorAll<HTMLDetailsElement>("details.composer-tools"))
        .filter((el) => el.getClientRects().length > 0).at(-1);
      if (menu && !menu.open) menu.open = true;
    }, 450);
    return () => clearTimeout(timer);
  }, [key]);

  // pressing the button, or the menu closing, counts as "got it"
  useEffect(() => {
    if (!teach) return;
    const press = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest(teach.selector)) markSeen(teach.key);
    };
    document.addEventListener("pointerdown", press, true);
    return () => document.removeEventListener("pointerdown", press, true);
  }, [teach]);
  return { teach, dismiss };
}

type Rect = { left: number; top: number; width: number; height: number };

function firstUnseen(): { key: string; el: HTMLElement } | null {
  for (const el of Array.from(document.querySelectorAll<HTMLElement>("[data-v3-nod]"))) {
    const key = el.dataset.v3Nod;
    if (!key || seen(`nod:${key}`)) continue;
    if (el.getClientRects().length === 0 || (el as HTMLButtonElement).disabled) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.bottom <= 0 || r.top >= window.innerHeight) continue;
    return { key, el };
  }
  return null;
}

const NOD = 30;
const NOD_MS = 2200;

/** First-time nods: the selected bot's mascot nods once at the primary
 * button of each new kind of card or screen ([data-v3-nod="kind"]). */
export function NodHost() {
  const { state } = useStore();
  const bot = state.bots.find((candidate) => candidate.id === state.selectedId) ?? state.bots[0];
  const hasBot = Boolean(bot);
  const [nod, setNod] = useState<{ key: string; rect: Rect } | null>(null);
  const busy = useRef(false);
  useEffect(() => {
    if (!hasBot) return;
    let frame = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const look = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (busy.current) return;
        // the first-run pointer already has the person's eye
        if (document.querySelector('[data-testid="v3-pointing"]')) return;
        const found = firstUnseen();
        if (!found) return;
        busy.current = true;
        markSeen(`nod:${found.key}`);
        const r = found.el.getBoundingClientRect();
        setNod({ key: found.key, rect: { left: r.left, top: r.top, width: r.width, height: r.height } });
        timer = setTimeout(() => {
          busy.current = false;
          setNod(null);
          look();
        }, NOD_MS);
      });
    };
    // a card mounts, then settles: wait a beat before looking
    const settle = () => {
      clearTimeout(settleTimer);
      settleTimer = setTimeout(look, 500);
    };
    let settleTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(look, 800);
    const mo = new MutationObserver(settle);
    mo.observe(document.body, { childList: true, subtree: true });
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      clearTimeout(settleTimer);
      mo.disconnect();
      busy.current = false;
      setNod(null);
    };
  }, [hasBot]);
  if (!bot || !nod) return null;
  const { rect } = nod;
  const above = rect.top - NOD - 10 >= 8;
  const left = Math.min(window.innerWidth - NOD - 8, Math.max(8, rect.left + rect.width - NOD / 2));
  const top = above ? rect.top - NOD - 6 : rect.top + rect.height + 6;
  return createPortal(
    <div className="pointer-events-none fixed inset-0 z-[54]" data-testid="v3-nod" data-nod={nod.key}>
      <div
        aria-hidden
        className="v3-nod-ring absolute rounded-[12px] ring-2 ring-accent/70"
        style={{ left: rect.left - 3, top: rect.top - 3, width: rect.width + 6, height: rect.height + 6 }}
      />
      <span className="v3-nod absolute flex" style={{ left, top }}>
        <ActivityMascot bot={bot} gesture="idle" face="happy" size={NOD} gaze={{ x: -0.4, y: above ? 0.8 : -0.8 }} />
      </span>
    </div>,
    document.body,
  );
}
