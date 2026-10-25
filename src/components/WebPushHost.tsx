import { useEffect, useRef, useState } from "react";
import { Bell } from "lucide-react";
import { t } from "@/lib/i18n";
import { openNotificationTarget, useStore, type AppState } from "@/state/store";
import {
  dismissWebPushOffer,
  enableWebPush,
  onNotificationOpen,
  refreshWebPush,
  shouldOfferWebPush,
  takeOpenTargetFromLocation,
  type WebPushTarget,
} from "@/lib/web-push";

/** Browser-tab notifications: routes push-banner clicks (from an open tab or a
 * tab the click just opened) to the exact thread and message, keeps an
 * existing subscription in step with this session, and offers notifications
 * once, at the moment they're obviously useful: a bot is working on
 * something the person just asked for. Renders nothing in the desktop app. */
export function WebPushHost() {
  const { state, dispatch } = useStore();
  const latest = useRef<AppState>(state);
  latest.current = state;
  // read once: the first render takes the target off the address bar
  const pending = useRef<WebPushTarget | null | undefined>(undefined);
  if (pending.current === undefined) pending.current = takeOpenTargetFromLocation();
  const [offer, setOffer] = useState(false);
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    const open = (target: WebPushTarget) => {
      if (target.kind === "digest" || (!target.threadId && !target.roomId)) return dispatch({ type: "showNeedsMe" });
      const opened = openNotificationTarget(dispatch, {
        botId: target.botId ?? "",
        threadId: target.threadId ?? "",
        ...(target.messageId ? { messageId: target.messageId } : {}),
        ...(target.roomId ? { roomId: target.roomId } : {}),
      }, latest.current);
      if (opened && target.threadId) dispatch({ type: "revealThread", threadId: target.threadId });
    };
    const stop = onNotificationOpen((target) => {
      if (latest.current.rosterLoaded) open(target);
      else pending.current = target;
    });
    if (latest.current.rosterLoaded && pending.current) {
      open(pending.current);
      pending.current = null;
    }
    return stop;
  }, [dispatch, state.rosterLoaded]);

  useEffect(() => {
    if (state.rosterLoaded) void refreshWebPush();
  }, [state.rosterLoaded]);

  const working = state.rosterLoaded && state.activeView === "chat" && state.bots.some((bot) => bot.busy && !bot.homeLink);
  useEffect(() => {
    if (!working || offer || !shouldOfferWebPush()) return;
    // a beat after the turn starts, so it doesn't jump in front of the reply
    const timer = setTimeout(() => setOffer(shouldOfferWebPush()), 4000);
    return () => clearTimeout(timer);
  }, [working, offer]);

  if (!offer) return null;
  const close = () => { dismissWebPushOffer(); setOffer(false); };
  return (
    <aside aria-label={t("webPush.offer.title")} className="fixed bottom-24 right-4 z-40 w-[320px] max-w-[calc(100vw-2rem)] rounded-xl border border-hairline bg-panel p-4 shadow-lg">
      <div className="mb-1 flex items-center gap-2 text-sm font-medium text-ink"><Bell size={14} />{t("webPush.offer.title")}</div>
      <p className="mb-3 text-[13px] leading-relaxed text-ink-secondary">{t("webPush.offer.body")}</p>
      <div className="flex items-center gap-3 text-sm">
        <button
          type="button"
          disabled={asking}
          className="rounded-lg bg-accent px-3 py-1.5 font-medium text-white disabled:opacity-60"
          onClick={() => {
            setAsking(true);
            void enableWebPush().catch(() => "off").finally(() => { setAsking(false); close(); });
          }}
        >
          {t("webPush.offer.yes")}
        </button>
        <button type="button" className="text-ink-secondary" onClick={close}>{t("webPush.offer.no")}</button>
      </div>
    </aside>
  );
}
