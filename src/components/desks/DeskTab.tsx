// A desk tab: one app bos works in, beside the chat. On top the live view
// (bos's browser tab on the app's site, or bos's own WhatsApp Web) with take
// over / hand back; below the cards bos wrote for that app in openui. A
// card's buttons talk to bos in this conversation, so anything that sends,
// posts, pays or deletes still goes through bos's normal approvals.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bot, Check, ExternalLink, Hand, Loader2, LogIn, Pin, PinOff } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";

import { deskCardSource, deskMatchesUrl, type Desk, type DeskCard } from "../../../shared/desks";
import { COMPOSER_INSERT_EVENT, type ComposerInsertDetail } from "@/components/canvas/canvas";
import { nativeWhatsAppLabel, type NativeWhatsAppSnapshot } from "@/components/NativeWhatsAppTile";
import { useSkinScheme } from "@/components/SmartUiBlock";
import { sendBrowserCommand, useBrowserTabs } from "@/components/workbench/browser-tabs";
import { useWorkspace } from "@/components/workspace/WorkspaceContext";
import { cn } from "@/lib/cn";
import type { TerminalTarget } from "@/lib/terminal";
import type { WorkspaceTab } from "@/lib/thread-workspace";
import { SmartUi } from "@/openui/SmartUi";
import { api, useStore } from "@/state/store";
import { deskApi, useDesk, useWhatsAppHold } from "./desks-client";

const LIVE_POLL = 1500;
const STARTERS = [
  { label: "today's summary", prompt: "make a card on this desk with today's summary" },
  { label: "a list to act on", prompt: "make a card on this desk listing what needs me, with a button on each" },
  { label: "add a button", prompt: "add a button to this desk that " },
];

interface Props { tab: WorkspaceTab; target: TerminalTarget; active: boolean; setTab: (patch: { title?: string }) => void }

/** Ask bos in this conversation, as the person. */
function useAskBos(target: TerminalTarget) {
  const { dispatch } = useStore();
  return useCallback((text: string) => dispatch({ type: "send", botId: target.botId, threadId: target.threadId, text }), [dispatch, target.botId, target.threadId]);
}

const typeInChat = (target: TerminalTarget, text: string) =>
  window.dispatchEvent(new CustomEvent<ComposerInsertDetail>(COMPOSER_INSERT_EVENT, { detail: { botId: target.botId, threadId: target.threadId, text } }));

/** Runs fn every ms while the tab is on screen and the window is visible. */
function useTick(enabled: boolean, ms: number, fn: () => void) {
  const ref = useRef(fn); ref.current = fn;
  useEffect(() => {
    if (!enabled) return;
    ref.current();
    const timer = setInterval(() => { if (document.visibilityState === "visible") ref.current(); }, ms);
    return () => clearInterval(timer);
  }, [enabled, ms]);
}

export function DeskTab({ tab, target, active, setTab }: Props) {
  const { desk, error } = useDesk(target.botId, tab.ref ?? "");
  const setTabRef = useRef(setTab); setTabRef.current = setTab;
  useEffect(() => { if (desk && desk.name !== tab.title) setTabRef.current({ title: desk.name }); }, [desk, tab.title]);

  if (desk === undefined) return <p className="p-5 text-[13px] text-ink-secondary">{error || "Loading…"}</p>;
  if (desk === null) return <p className="p-5 text-[13px] text-ink-secondary" data-testid="desk-gone">This desk was removed. Ask bos to open it again.</p>;
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-app" data-testid="desk-tab" data-desk-id={desk.id}>
      <DeskHeader desk={desk} />
      <div className="flex flex-col gap-4 px-4 pb-10 pt-3 sm:px-6">
        {desk.kind === "whatsapp" ? <WhatsAppLive active={active} /> : <BrowserLive desk={desk} active={active} target={target} />}
        {error && <p role="alert" className="text-[13px] text-danger">{error}</p>}
        <DeskCards desk={desk} target={target} />
      </div>
    </div>
  );
}

function DeskHeader({ desk }: { desk: Desk }) {
  const [busy, setBusy] = useState(false);
  const pin = async () => {
    setBusy(true);
    try { await deskApi.patch(desk.botId, desk.id, { pinned: !desk.pinned }); } finally { setBusy(false); }
  };
  return (
    <div className="flex items-center gap-2 border-b border-hairline px-4 py-2.5 sm:px-6">
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-[15px] font-medium text-ink">{desk.name}</h1>
        <p className="truncate text-[12px] text-ink-secondary">{desk.kind === "whatsapp" ? "WhatsApp" : desk.host}</p>
      </div>
      <button type="button" onClick={pin} disabled={busy} data-testid="desk-pin" aria-pressed={desk.pinned}
        title={desk.pinned ? "Unpin from new tabs" : "Pin to new tabs, so this desk is one click away"}
        className="inline-flex h-8 items-center gap-1.5 rounded-full border border-hairline px-3 text-[13px] text-ink-secondary hover:bg-raised/50 hover:text-ink disabled:opacity-50">
        {desk.pinned ? <PinOff size={14} /> : <Pin size={14} />}{desk.pinned ? "Unpin" : "Pin"}
      </button>
    </div>
  );
}

function LiveFrame({ children, footer }: { children: React.ReactNode; footer: React.ReactNode }) {
  return (
    <section className="overflow-hidden rounded-xl border border-hairline bg-raised/30" data-testid="desk-live">
      <div className="relative flex aspect-[16/10] max-h-[46vh] w-full items-center justify-center overflow-hidden bg-black/5">{children}</div>
      <div className="flex flex-wrap items-center gap-2 border-t border-hairline px-3 py-2 text-[13px]">{footer}</div>
    </section>
  );
}

const ghost = "inline-flex h-7 items-center gap-1.5 rounded-full border border-hairline px-2.5 text-[12.5px] text-ink-secondary hover:bg-raised/60 hover:text-ink disabled:opacity-50";
const solid = "inline-flex h-7 items-center gap-1.5 rounded-full bg-ink px-2.5 text-[12.5px] text-app hover:opacity-90 disabled:opacity-50";

function BrowserLive({ desk, active, target }: { desk: Desk; active: boolean; target: TerminalTarget }) {
  const bridge = globalThis.window?.ogb?.primaryBrowser;
  const { tabs } = useBrowserTabs();
  const { openTab } = useWorkspace();
  const ask = useAskBos(target);
  const match = tabs.find((tab) => deskMatchesUrl(desk, tab.url));
  const [profile, setProfile] = useState<string>();
  const [shot, setShot] = useState<string | null>(null);
  const [problem, setProblem] = useState("");
  const [signingIn, setSigningIn] = useState(false);
  useEffect(() => {
    let live = true;
    void bridge?.action("profiles").then((data) => { if (live) setProfile(data.selected); }).catch(() => undefined);
    return () => { live = false; };
  }, [bridge]);

  useTick(Boolean(active && bridge && profile && match), LIVE_POLL, () => {
    if (!bridge || !profile || !match) return;
    let guestId: number | undefined;
    try { guestId = (document.querySelector(`[data-primary-tab="${match.id}"] webview`) as (Element & { getWebContentsId(): number }) | null)?.getWebContentsId(); } catch { guestId = undefined; }
    if (!guestId) { setShot(null); return; }
    // one missed frame keeps the last picture; the page going away clears it (above)
    bridge.action("thumbnail", { profileId: profile, guestId }).then((image) => { if (typeof image === "string") setShot(image); }, () => undefined);
  });
  useEffect(() => { if (!match) setShot(null); }, [match]);

  const watch = () => {
    openTab("browser");
    sendBrowserCommand(match ? { op: "activate", id: match.id } : { op: "new", url: desk.url, reuseBlank: true });
  };
  const control = (action: "agent-take-over" | "agent-give-back") => {
    if (!bridge || !match) return;
    setProblem("");
    bridge.action(action, { tabId: match.id }).catch(() => setProblem("Could not change who controls the browser."));
  };
  const signedIn = async () => {
    setSigningIn(true);
    try {
      await deskApi.patch(desk.botId, desk.id, { status: "ready" });
      ask(`i'm signed in to ${desk.name}, carry on`);
    } catch (e) { setProblem(e instanceof Error ? e.message : String(e)); } finally { setSigningIn(false); }
  };

  if (!bridge) {
    return (
      <LiveFrame footer={desk.url ? <a href={desk.url} target="_blank" rel="noopener noreferrer" className={ghost}><ExternalLink size={13} />Open {desk.host}</a> : null}>
        <p className="px-6 text-center text-[13px] text-ink-secondary">The live view runs in the BOS Bot desktop app, where bos has its browser.</p>
      </LiveFrame>
    );
  }

  const footer = (
    <>
      {match?.agent === "bot" && <><span className="inline-flex items-center gap-1.5 text-ink"><Bot size={14} />bos is working</span>
        <button type="button" className={solid} onClick={() => control("agent-take-over")} data-testid="desk-takeover"><Hand size={13} />Take over</button></>}
      {match?.agent === "person" && <><span className="text-ink">You have control</span>
        <button type="button" className={solid} onClick={() => control("agent-give-back")} data-testid="desk-handback"><Bot size={13} />Hand back to bos</button></>}
      {!match?.agent && <span className="text-ink-secondary">{match ? "Open in the browser" : "Not open yet"}</span>}
      <span className="flex-1" />
      <button type="button" className={ghost} onClick={watch} data-testid="desk-watch">{match ? "Watch" : "Open"}</button>
      {problem && <span role="alert" className="w-full text-[12px] text-danger">{problem}</span>}
    </>
  );

  return (
    <>
      {desk.status === "needs_sign_in" && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-hairline px-3 py-2.5 text-[13px]" data-testid="desk-sign-in">
          <LogIn size={15} className="text-ink-secondary" />
          <span className="min-w-0 flex-1 text-ink">Sign in to {desk.host} in bos's browser. You type the password; bos never sees it.</span>
          <button type="button" className={ghost} onClick={watch}>Sign in</button>
          <button type="button" className={solid} onClick={signedIn} disabled={signingIn} data-testid="desk-signed-in"><Check size={13} />I'm signed in</button>
        </div>
      )}
      <LiveFrame footer={footer}>
        {shot
          ? <img src={shot} alt={`${desk.name}, live`} className="h-full w-full object-contain object-top" draggable={false} />
          : <p className="px-6 text-center text-[13px] text-ink-secondary">{match ? "Open the browser to watch bos here." : `bos opens ${desk.host} when it starts working. Or open it now.`}</p>}
      </LiveFrame>
    </>
  );
}

function WhatsAppLive({ active }: { active: boolean }) {
  const [held, setHeld] = useWhatsAppHold();
  const [snapshot, setSnapshot] = useState<NativeWhatsAppSnapshot | null>(null);
  const [frame, setFrame] = useState<string | null>(null);
  const [problem, setProblem] = useState("");
  const linked = snapshot?.state === "linked";
  useTick(active, 4000, () => {
    api<{ whatsapp?: NativeWhatsAppSnapshot }>("/api/whatsapp/native").then((r) => setSnapshot(r.whatsapp ?? null), () => setSnapshot(null));
  });
  useTick(active && linked, LIVE_POLL, () => {
    // load off screen, then swap, so the picture never blinks
    const url = `/api/whatsapp/native/screen?t=${Date.now()}`;
    const image = new Image();
    image.onload = () => setFrame(url);
    image.onerror = () => setFrame(null);
    image.src = url;
  });
  const toggle = async (on: boolean) => {
    setProblem("");
    try { await setHeld(on); } catch (e) { setProblem(e instanceof Error ? e.message : String(e)); }
  };

  const footer = linked
    ? <>
        {held
          ? <><span className="text-ink">You have control. bos won't reply or send.</span>
              <button type="button" className={solid} onClick={() => toggle(false)} data-testid="desk-handback"><Bot size={13} />Hand back to bos</button></>
          : <><span className="inline-flex items-center gap-1.5 text-ink"><Bot size={14} />bos is on WhatsApp</span>
              <button type="button" className={solid} onClick={() => toggle(true)} disabled={held === undefined} data-testid="desk-takeover"><Hand size={13} />Take over</button></>}
        {problem && <span role="alert" className="w-full text-[12px] text-danger">{problem}</span>}
      </>
    : <span className="text-ink-secondary">{snapshot ? nativeWhatsAppLabel(snapshot) : "Checking WhatsApp…"}</span>;

  return (
    <LiveFrame footer={footer}>
      {linked && frame && <img src={frame} alt="WhatsApp, live" className={cn("h-full w-full object-contain object-top", held && "opacity-70")} draggable={false} />}
      {linked && !frame && <Loader2 size={18} className="animate-spin text-ink-secondary" />}
      {snapshot?.state === "qr_pending" && snapshot.qr && (
        <div className="flex flex-col items-center gap-2 rounded-lg bg-white p-3"><QRCodeSVG value={snapshot.qr} size={168} /><span className="text-[12px] text-black/70">WhatsApp → Settings → Linked devices</span></div>
      )}
      {!linked && snapshot?.state !== "qr_pending" && <p className="px-6 text-center text-[13px] text-ink-secondary">Link WhatsApp in Connected apps and bos works it here.</p>}
    </LiveFrame>
  );
}

function DeskCards({ desk, target }: { desk: Desk; target: TerminalTarget }) {
  const ask = useAskBos(target);
  if (!desk.cards.length) {
    return (
      <section className="flex flex-col items-start gap-3 rounded-xl border border-dashed border-hairline px-4 py-5" data-testid="desk-empty">
        <p className="text-[14px] text-ink">No cards yet. Ask bos in the chat for the controls you want here.</p>
        <div className="flex flex-wrap gap-2">
          {STARTERS.map((s) => (
            <button key={s.label} type="button" className={ghost} onClick={() => typeInChat(target, s.prompt)}>{s.label}</button>
          ))}
        </div>
      </section>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {desk.cards.map((card) => <DeskCardView key={card.id} desk={desk} card={card} ask={ask} />)}
    </div>
  );
}

function DeskCardView({ desk, card, ask }: { desk: Desk; card: DeskCard; ask: (text: string) => void }) {
  const theme = useSkinScheme();
  const code = useMemo(() => deskCardSource(card), [card]);
  // a button names its desk, so bos knows which app it is about from any chat
  const onAssistant = useCallback((text: string) => ask(`[${desk.name} desk] ${text}`), [ask, desk.name]);
  const onOpenUrl = useCallback((url: string) => { window.open(url, "_blank", "noopener,noreferrer"); }, []);
  return (
    <section className="rounded-xl border border-hairline px-3.5 py-3" data-testid="desk-card" data-card-id={card.id}>
      <header className="mb-1 flex items-baseline gap-2">
        <h2 className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink-secondary">{card.title}</h2>
        <time className="shrink-0 text-[11.5px] text-ink-tertiary" dateTime={new Date(card.updatedAt).toISOString()}>{ago(card.updatedAt)}</time>
      </header>
      <SmartUi code={code} streaming={false} theme={theme} onAssistant={onAssistant} onOpenUrl={onOpenUrl}
        fallback={<p className="text-[13px] text-ink-secondary">This card couldn't draw. Ask bos to fix the {card.title} card.</p>} />
    </section>
  );
}

function ago(at: number): string {
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h ago` : new Date(at).toLocaleDateString();
}
