import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Loader2, RefreshCw, X } from "lucide-react";

import { api, type Message } from "@/state/store";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { ServiceIcon } from "./PluginsPanel";
import type { LocaleKey } from "@/locales";
import { reserveConnectionWindow } from "@/lib/connection-window";

export function ConnectorCard({ botId, threadId, message }: { botId: string; threadId: string; message: Message }) {
  const connector = message.connector!;
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | { key: LocaleKey } | null>(null);
  const polling = useRef(false);
  const [pendingUrl, setPendingUrl] = useState<string | null>(null);
  const connectWindow = useRef<ReturnType<typeof reserveConnectionWindow> | null>(null);
  useEffect(() => () => { connectWindow.current?.cancel(); }, []);
  useEffect(() => {
    if (connector.status === "failed") setPendingUrl(null);
  }, [connector.status]);

  const endpoint = `/api/bots/${encodeURIComponent(botId)}/connector-cards/${encodeURIComponent(message.id)}`;
  const checkStatus = useCallback(async () => {
    const result = await api(`${endpoint}/status?threadId=${encodeURIComponent(threadId)}`);
    return Boolean(result.connected);
  }, [endpoint, threadId]);

  useEffect(() => {
    if (connector.status !== "authorizing" || connector.dismissed) return;
    polling.current = true;
    let tries = 0;
    const timer = setInterval(() => {
      if (!polling.current) return;
      void checkStatus()
        .then((connected) => {
          tries += 1;
          if (connected || tries >= 75) {
            polling.current = false;
            clearInterval(timer);
          }
        })
        .catch(() => {
          tries += 1;
          if (tries >= 75) clearInterval(timer);
        });
    }, 4_000);
    return () => {
      polling.current = false;
      clearInterval(timer);
    };
  }, [checkStatus, connector.dismissed, connector.status]);

  if (connector.dismissed) return null;

  const connect = async () => {
    const reserved = reserveConnectionWindow();
    connectWindow.current = reserved;
    setBusy(true);
    setLocalError(null);
    try {
      const result = await api(`${endpoint}/authorize`, {
        method: "POST",
        body: JSON.stringify({ threadId }),
      });
      setPendingUrl(String(result.url));
      if (!await reserved.navigate(String(result.url))) {
        setLocalError({ key: "connectors.card.popupBlocked" });
      }
    } catch (error) {
      reserved.cancel();
      setLocalError(error instanceof Error ? error.message : String(error));
    } finally {
      connectWindow.current = null;
      setBusy(false);
    }
  };

  const resume = async () => {
    setBusy(true);
    setLocalError(null);
    try {
      await api(`${endpoint}/resume`, { method: "POST", body: JSON.stringify({ threadId }) });
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const dismiss = () => {
    void api(`${endpoint}/dismiss`, { method: "POST", body: JSON.stringify({ threadId }) }).catch(() => {});
  };

  const connected = connector.status === "connected";
  const authorizing = connector.status === "authorizing";
  const error = localError ?? connector.error;

  const pill =
    "flex h-9 shrink-0 items-center gap-1.5 rounded-full px-4 text-[13.5px] font-medium transition-[background-color,transform] active:scale-[0.97] disabled:opacity-50";

  // Grok's connect card: the app's own icon, its name and what the bot wants
  // it for, and one pill on the right. Status lives in the pill itself.
  return (
    <div className="flex w-full justify-start">
      <div data-tour="connector" className="animate-pop-in group/connector relative w-full max-w-[520px] rounded-2xl border border-hairline/40 bg-card px-4 py-3.5">
        <div className="flex items-center gap-3.5">
          <div className="flex size-14 shrink-0 items-center justify-center rounded-xl bg-raised p-2.5">
            <ServiceIcon card={{ label: connector.label, logo: `https://logos.composio.dev/api/${encodeURIComponent(connector.slug)}`, domain: null }} className="size-full rounded-lg" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[15px] font-medium text-ink">{connector.label}</div>
            <p className="mt-0.5 line-clamp-2 text-[13px] leading-snug text-ink-secondary">
              {authorizing
                ? t("connectors.card.waiting")
                : connected
                  ? connector.resumed
                    ? t("connectors.card.resumed")
                    : t("connectors.card.paused")
                  : connector.description}
            </p>
          </div>
          {!connected && pendingUrl ? (
            <a href={pendingUrl} target="_blank" rel="noopener noreferrer" onClick={() => setLocalError(null)} className={cn(pill, "border border-hairline text-ink hover:bg-raised")}>
              {t("connectors.action.continue")}
            </a>
          ) : !connected ? (
            <button
              type="button"
              onClick={() => void connect()}
              disabled={busy}
              title={t("connectors.card.signInHint")}
              className={cn(pill, "border border-hairline text-ink hover:bg-raised")}
            >
              {(busy || authorizing) && <Loader2 size={14} className="animate-spin" />}
              {authorizing
                ? t("connectors.card.openAgain")
                : connector.status === "failed"
                  ? t("connectors.card.tryAgain")
                  : t("connectors.action.connect")}
            </button>
          ) : !connector.resumed ? (
            <button type="button" onClick={() => void resume()} disabled={busy} className={cn(pill, "bg-ink text-app hover:bg-ink/90")}>
              {busy ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} {t("connectors.card.continueTask")}
            </button>
          ) : (
            <span className={cn(pill, "bg-success/15 text-success")}>
              <Check size={14} /> {t("connectors.card.connected")}
            </span>
          )}
        </div>
        {error && <p className="mt-2 ps-[70px] text-[12.5px] text-danger">{typeof error === "string" ? error : t(error.key)}</p>}
        {!connected && (
          <button
            type="button"
            onClick={dismiss}
            aria-label={t("connectors.card.notNow")}
            title={t("connectors.card.notNow")}
            className="absolute -end-2 -top-2 flex size-6 items-center justify-center rounded-full border border-hairline/60 bg-menu text-ink-secondary opacity-0 shadow-md transition-opacity hover:text-ink focus-visible:opacity-100 group-hover/connector:opacity-100"
          >
            <X size={13} />
          </button>
        )}
      </div>
    </div>
  );
}
