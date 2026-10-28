import { useCallback, useEffect, useRef, useState } from "react";
import { CircleAlert } from "lucide-react";
import type { HealthReport } from "../../shared/doctor";
import { api, openThread, useStore } from "@/state/store";
import { track } from "@/lib/analytics";
import { t } from "@/lib/i18n";
import { buildFixIts, type FixIt } from "@/lib/v3-fix-it";
import type { InboxItem } from "@/lib/inbox";

const FOCUS_RECHECK_MS = 2 * 60_000;

/** The card's failure class for the funnel; ids carry names, so only the kind leaves. */
export function fixItCheck(id: string): string {
  const kind = id.split(":")[0];
  if (kind === "engine" || kind === "cli" || kind === "dead") return "engine";
  if (kind === "computer" || kind === "server") return "network";
  if (kind === "app") return "auth";
  if (kind === "disk") return "storage";
  return kind === "whatsapp" ? "whatsapp" : "unknown";
}

/** The health check, read on mount, when `key` moves (a bot stalled or a
 * computer dropped) and on window focus at most every two minutes. A
 * non-admin viewer gets a 403 and simply sees no health cards. */
export function useDoctorReport(enabled: boolean, key: string) {
  const [report, setReport] = useState<HealthReport | null>(null);
  const lastAt = useRef(0);
  // every read and repair takes a ticket; only the newest may land, so an
  // older warning can never paint over a report taken after the fix
  const ticket = useRef(0);
  const land = useCallback((request: Promise<HealthReport>, fallback: "keep" | "clear") => {
    const mine = ++ticket.current;
    request.then((value) => { if (ticket.current === mine) setReport(value); },
      () => { if (ticket.current === mine && fallback === "clear") setReport(null); });
  }, []);
  const load = useCallback(() => {
    lastAt.current = Date.now();
    land(api<HealthReport>("/api/doctor"), "clear");
  }, [land]);
  useEffect(() => {
    if (!enabled) { ticket.current += 1; setReport(null); return; }
    load();
    const onFocus = () => { if (Date.now() - lastAt.current >= FOCUS_RECHECK_MS) load(); };
    window.addEventListener("focus", onFocus);
    return () => { ticket.current += 1; window.removeEventListener("focus", onFocus); };
  }, [enabled, key, load]);
  return [report, land] as const;
}

/** 3.0: one card per thing the person can fix, each with one button. */
export function V3FixIt({ reconnects, onOpen }: { reconnects: readonly InboxItem[]; onOpen?: () => void }) {
  const { state, dispatch } = useStore();
  // closing settings re-checks too, so a card is gone once its fix is done
  const key = state.bots.map((bot) => `${bot.id}:${bot.activity === "dead" || bot.activity === "no-signal" ? 1 : 0}:${bot.remote?.online === false ? 0 : 1}:${bot.homeLink?.online === false ? 0 : 1}`).join(",")
    + (state.appSettingsOpen ? "|settings" : "");
  const [report, land] = useDoctorReport(true, key);
  const [busy, setBusy] = useState<string | null>(null);
  const cards = buildFixIts({ report, bots: state.bots, asks: reconnects });
  if (!cards.length) return null;
  const run = (card: FixIt) => {
    const action = card.action;
    track("card_clicked", { card: "fixit", check: fixItCheck(card.id) });
    if (action.kind === "settings") { dispatch({ type: "toggleAppSettings", open: true, section: action.section }); return; }
    if (action.kind === "thread") { onOpen?.(); openThread(dispatch, { botId: action.botId, threadId: action.threadId }, state); return; }
    setBusy(card.id);
    const fix = api<HealthReport>("/api/doctor/fix", { method: "POST", body: JSON.stringify({ action: action.action }) });
    land(fix, "keep");
    void fix.catch(() => undefined).finally(() => setBusy(null));
  };
  return <section data-v3-head data-testid="v3-fixit" aria-label={t("v3.fixit.label")} className="flex flex-col gap-1.5 px-1 pt-2">
    {cards.map((card) => <div key={card.id} data-fixit={card.id} role="alert"
      className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2">
      <CircleAlert size={14} className="mt-0.5 shrink-0 text-danger" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-ink">{card.title}</div>
        {card.detail && <div className="mt-0.5 line-clamp-2 text-[11px] text-ink-secondary">{card.detail}</div>}
      </div>
      <button type="button" disabled={busy === card.id} onClick={() => run(card)}
        className="shrink-0 rounded-full bg-danger/15 px-2.5 py-1 text-[12px] font-medium text-ink outline-none hover:bg-danger/25 focus-visible:ring-1 focus-visible:ring-hairline disabled:opacity-60">
        {card.button}
      </button>
    </div>)}
  </section>;
}
