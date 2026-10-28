import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Loader2, RefreshCw, X } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";

import { api, useOptionalStore, type ConnectorCardData, type Message } from "@/state/store";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { useV3 } from "@/lib/v3";
import { track } from "@/lib/analytics";
import { ServiceIcon } from "./PluginsPanel";
import type { LocaleKey } from "@/locales";
import { reserveConnectionWindow } from "@/lib/connection-window";
import type { NativeWhatsAppSnapshot } from "./NativeWhatsAppTile";
import { connectActions } from "../../shared/connect-actions";

// 3.0 funnel: connect cards clicked this app session, by message id. Kept
// outside the card so a connect that finishes after the person switched
// threads and came back still reports how it ended.
const connectsStarted = new Set<string>();

export function ConnectorCard({ botId, threadId, message }: { botId: string; threadId: string; message: Message }) {
  const connector = message.connector!;
  const v3 = useV3();
  const storeContext = useOptionalStore();
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | { key: LocaleKey } | null>(null);
  const polling = useRef(false);
  const [pendingUrl, setPendingUrl] = useState<string | null>(null);
  // a WhatsApp card links on this computer (server/whatsapp-service.ts): no
  // sign-in page, the QR shows in the card until the phone scans it
  const [native, setNative] = useState<NativeWhatsAppSnapshot | null>(null);
  const connectWindow = useRef<ReturnType<typeof reserveConnectionWindow> | null>(null);
  useEffect(() => () => { connectWindow.current?.cancel(); }, []);
  useEffect(() => {
    if (connector.status === "failed") setPendingUrl(null);
  }, [connector.status]);
  // 3.0 funnel: how a connect started from this card ended. Only a connect
  // clicked here counts, never an old card that renders connected.
  useEffect(() => {
    if (!v3 || !connectsStarted.has(message.id)) return;
    if (connector.status !== "connected" && connector.status !== "failed") return;
    connectsStarted.delete(message.id);
    track("connect_finished", { success: connector.status === "connected", source: "chat" });
  }, [connector.status, v3, message.id]);

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

  useEffect(() => {
    if (!native || connector.status === "connected" || connector.dismissed) return;
    if (native.state !== "qr_pending" && native.state !== "linking") return;
    const timer = setTimeout(() => {
      void api("/api/whatsapp/native").then((result) => { if (result?.whatsapp) setNative(result.whatsapp); }).catch(() => {});
    }, 2_000);
    return () => clearTimeout(timer);
  }, [native, connector.status, connector.dismissed]);

  // v3 after-connect actions post into this conversation as the person, the
  // same way a card button does (SmartUiBlock). Only on a click: the resume
  // already continues the paused task, so nothing here sends by itself.
  const sendAsPerson = useCallback((text: string) => {
    if (!storeContext) return;
    const { state, dispatch } = storeContext;
    const group = state.groups.find((candidate) => candidate.threadId === threadId);
    if (group) dispatch({ type: "sendGroup", groupId: group.id, threadId, text });
    else dispatch({ type: "send", botId, threadId, text });
  }, [botId, storeContext, threadId]);

  if (connector.dismissed) return null;

  const connect = async () => {
    if (v3) {
      connectsStarted.add(message.id);
      track("connect_started", { source: "chat" });
    }
    if (connector.slug === "whatsapp") {
      setBusy(true);
      setLocalError(null);
      try {
        const result = await api(`${endpoint}/authorize`, { method: "POST", body: JSON.stringify({ threadId }) });
        if (result?.native) {
          setNative(result.whatsapp ?? null);
          return;
        }
        // native WhatsApp is turned off here: the Composio sign-in page, behind
        // the card's Continue link (no popup after an await)
        setPendingUrl(String(result.url));
      } catch (error) {
        setLocalError(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(false);
      }
      return;
    }
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

  return (
    <ConnectorCardView
      connector={connector}
      v3={v3}
      native={native}
      pendingUrl={pendingUrl}
      busy={busy}
      error={localError}
      onConnect={() => void connect()}
      onResume={() => void resume()}
      onDismiss={dismiss}
      onContinueLink={() => setLocalError(null)}
      onAction={sendAsPerson}
    />
  );
}

export interface ConnectorCardViewProps {
  connector: ConnectorCardData;
  /** v3 previews: composes "<bot> needs <app> <reason>" from the reason. Live
   * cards leave it out; the server already wrote that line as the description. */
  botName?: string;
  /** 3.0 cards. Off, the card draws exactly what it drew in 2.x. */
  v3?: boolean;
  native?: NativeWhatsAppSnapshot | null;
  pendingUrl?: string | null;
  busy?: boolean;
  error?: string | { key: LocaleKey } | null;
  onConnect?: () => void;
  onResume?: () => void;
  onDismiss?: () => void;
  onContinueLink?: () => void;
  /** v3 after-connect action: send this text to the bot as the person. */
  onAction?: (text: string) => void;
}

/** The connector card with no network: everything it shows comes in as
 * props. ConnectorCard feeds it live state; the gallery feeds it
 * CONNECTOR_PREVIEWS. */
export function ConnectorCardView({
  connector,
  botName,
  v3 = false,
  native = null,
  pendingUrl = null,
  busy = false,
  error: localError = null,
  onConnect,
  onResume,
  onDismiss,
  onContinueLink,
  onAction,
}: ConnectorCardViewProps) {
  // one tap per action: a second tap on the same one would send it twice
  const [sent, setSent] = useState<readonly string[]>([]);
  if (connector.dismissed) return null;

  const connected = connector.status === "connected";
  const authorizing = connector.status === "authorizing";
  const error = localError ?? connector.error;
  const reconnect = v3 && connector.reconnect === true;
  const description = reconnect
    ? t("connectors.card.signInAgain", { label: connector.label })
    : v3 && botName && connector.reason && !connector.alias
      ? `${botName} needs ${connector.label} ${connector.reason}`
      : connector.description;
  const actions = v3 && connected && connector.resumed ? connectActions(connector.slug, connector.label) : [];

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
                  : description}
            </p>
          </div>
          {!connected && pendingUrl ? (
            <a href={pendingUrl} target="_blank" rel="noopener noreferrer" data-v3-point="connect" onClick={onContinueLink} className={cn(pill, "border border-hairline text-ink hover:bg-raised")}>
              {t("connectors.action.continue")}
            </a>
          ) : !connected ? (
            <button
              type="button"
              onClick={onConnect}
              data-v3-point="connect"
              disabled={busy}
              title={t("connectors.card.signInHint")}
              className={cn(pill, "border border-hairline text-ink hover:bg-raised")}
            >
              {(busy || authorizing) && <Loader2 size={14} className="animate-spin" />}
              {authorizing
                ? t("connectors.card.openAgain")
                : connector.status === "failed"
                  ? t("connectors.card.tryAgain")
                  : reconnect
                    ? t("connectors.card.reconnect")
                    : t("connectors.action.connect")}
            </button>
          ) : !connector.resumed ? (
            <button type="button" onClick={onResume} disabled={busy} className={cn(pill, "bg-ink text-app hover:bg-ink/90")}>
              {busy ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} {t("connectors.card.continueTask")}
            </button>
          ) : (
            <span className={cn(pill, "bg-success/15 text-success")}>
              <Check size={14} /> {t("connectors.card.connected")}
            </span>
          )}
        </div>
        {!connected && native?.state === "qr_pending" && native.qr && (
          <div className="mt-3 flex items-center gap-4 ps-[70px]">
            <div className="rounded-xl bg-white p-2.5">
              <QRCodeSVG value={native.qr} size={168} />
            </div>
            <p className="text-[12.5px] leading-relaxed text-ink-secondary">
              On your phone open WhatsApp → Settings → Linked devices → Link a device, and scan this code. Linking only lets your bot read; it can't send anything.
            </p>
          </div>
        )}
        {!connected && native && (native.state === "needs_rescan" || native.state === "disconnected") && native.reason && (
          <p className="mt-2 ps-[70px] text-[12.5px] text-ink-secondary">{native.reason}</p>
        )}
        {error && <p className="mt-2 ps-[70px] text-[12.5px] text-danger">{typeof error === "string" ? error : t(error.key)}</p>}
        {actions.length > 0 && (
          <div className="mt-3 ps-[70px]" data-v3-point="connect-actions">
            <div className="text-[12px] font-medium text-ink-secondary">{t("connectors.card.whatNow")}</div>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {actions.map((action) => {
                const done = sent.includes(action.text);
                return (
                  <button
                    key={action.text}
                    type="button"
                    disabled={done || !onAction}
                    onClick={() => {
                      if (done || !onAction) return;
                      setSent((current) => [...current, action.text]);
                      onAction(action.text);
                    }}
                    className="rounded-full border border-hairline px-3 py-1.5 text-start text-[13px] text-ink transition-colors hover:bg-raised disabled:opacity-50"
                  >
                    {action.text}
                  </button>
                );
              })}
            </div>
          </div>
        )}
        {!connected && (
          <button
            type="button"
            onClick={onDismiss}
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

const previewGmail: ConnectorCardData = {
  slug: "gmail",
  label: "Gmail",
  description: "Read and send email",
  status: "required",
  resumeKey: "preview",
  reason: "so i can draft those 4 replies",
};

/** Fixed v3 card states for a gallery or a screenshot: no store, no network.
 * Render each with <ConnectorCardView {...props} />. */
export const CONNECTOR_PREVIEWS: Array<{ title: string } & ConnectorCardViewProps> = [
  { title: "required with reason", v3: true, botName: "Pepper", connector: previewGmail },
  { title: "authorizing", v3: true, botName: "Pepper", connector: { ...previewGmail, status: "authorizing" } },
  { title: "connected with actions", v3: true, botName: "Pepper", connector: { ...previewGmail, status: "connected", resumed: true }, onAction: () => {} },
  { title: "failed", v3: true, botName: "Pepper", connector: { ...previewGmail, status: "failed", error: "Gmail didn't finish signing in. Try again." } },
  {
    title: "whatsapp qr",
    v3: true,
    botName: "Pepper",
    connector: { slug: "whatsapp", label: "WhatsApp", description: "Link WhatsApp on this computer so the bot can read your chats", status: "required", resumeKey: "preview-wa", reason: "to find the chat with sam" },
    native: { state: "qr_pending", qr: "fake-preview-qr", reason: null, sessionExists: false, circuitOpen: false, failures: 0, nextRetryAt: null, messageCount: 0 },
  },
  { title: "reconnect", v3: true, botName: "Pepper", connector: { ...previewGmail, reason: undefined, reconnect: true, description: "Gmail needs signing in again" } },
];
