import { t } from "@/lib/i18n";
import {
  Loader2,
  ShieldCheck,
  Smartphone,
  Trash2,
} from "lucide-react";
import {
  PhoneSetupFlowView,
  companionAccountActionError,
  companionBridge,
  loadCompanionBridgeState,
  shouldHydrateCompanionEmail,
  type CompanionState,
  type PhoneSetupController,
  usePhoneSetupController,
} from "./PhoneSetupFlow";
import { companionPairingMode } from "../lib/phone-setup";
import { Card, Switch } from "./SettingsPrimitives";
import { brand } from "../lib/brand";

export {
  companionAccountActionError,
  companionPairingMode,
  loadCompanionBridgeState,
  shouldHydrateCompanionEmail,
};

export interface CompanionPanelStatus {
  label: string;
  good: boolean;
}

export function pairingSurfaceCopy(
  route: Pick<PhoneSetupController, "localFallback" | "tailscaleFallback">,
): { title: string; subtitle: string } {
  if (route.tailscaleFallback) {
    return {
      title: t("remote.pairing.tailscale.title"),
      subtitle: t("remote.pairing.tailscale.subtitle"),
    };
  }
  if (route.localFallback) {
    return {
      title: t("remote.pairing.wifi.title"),
      subtitle: t("remote.pairing.wifi.subtitle"),
    };
  }
  return {
    title: t("remote.pairing.https.title"),
    subtitle: t("remote.pairing.https.subtitle"),
  };
}

export function deriveCompanionPanelStatus(
  state: Pick<CompanionState, "enabled" | "devices" | "error">,
): CompanionPanelStatus | null {
  if (state.error) return { label: t("remote.status.attention"), good: false };
  if (!state.enabled) return { label: t("remote.status.off"), good: false };
  const pairedCount = state.devices.length;
  if (!pairedCount) return null;
  return {
    label: `${pairedCount} ${pairedCount === 1 ? "device" : "devices"} paired`,
    good: true,
  };
}

const relative = (at: number) => {
  const seconds = Math.round((Date.now() - at) / 1000);
  if (seconds < 90) return t("remote.time.justNow");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t("remote.time.minutes", { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t("remote.time.hours", { count: hours });
  return t("remote.time.days", { count: Math.round(hours / 24) });
};

export function CompanionSection({ profileEmail = "" }: { profileEmail?: string }) {
  const c = usePhoneSetupController(profileEmail);
  const state = c.state;

  if (!companionBridge()) {
    return (
      <Card
        title={t("remote.desktopOnly.title", { app: brand().name })}
        subtitle={t("remote.desktopOnly.subtitle")}
      />
    );
  }

  if (!state) {
    return (
      <Card title={t("remote.title")} subtitle={t("remote.checking")}>
        <Loader2 size={15} className="animate-spin text-ink-secondary" />
      </Card>
    );
  }

  const pairedCount = state.devices.length;
  const panelStatus = deriveCompanionPanelStatus(state);
  const pairingCopy = pairingSurfaceCopy(c);
  return (
    <div className="flex flex-col gap-4">
      <div>
        <Card title={pairingCopy.title} subtitle={pairingCopy.subtitle}>
          {(panelStatus || (pairedCount > 0 && c.hostedReady && !c.moveRequired)) && (
            <div className="mb-4 flex items-center justify-between gap-3">
              {panelStatus && (
                <div
                  className={`flex items-center gap-2 rounded-full px-2.5 py-1 text-[11.5px] ${
                    panelStatus.good ? "bg-success/10 text-success" : "bg-control text-ink-secondary"
                  }`}
                >
                  <span className={`size-1.5 rounded-full ${panelStatus.good ? "bg-success" : "bg-ink-secondary/50"}`} />
                  {panelStatus.label}
                </div>
              )}
              {pairedCount > 0 && c.hostedReady && !c.moveRequired && (
                <div className="flex items-center gap-1.5 text-[11.5px] text-ink-secondary">
                  <ShieldCheck size={13} className="text-accent" /> {t("remote.worksAway")}
                </div>
              )}
            </div>
          )}
          <PhoneSetupFlowView controller={c} variant="settings" />
          {state.error && <div className="mt-3 text-[12px] text-danger">{state.error}</div>}
        </Card>
      </div>

      <Card
        title={t("remote.devices.title")}
        subtitle={
          pairedCount
            ? t("remote.devices.subtitle", { app: brand().name })
            : t("remote.devices.empty")
        }
      >
        {pairedCount > 0 && (
          <ul className="flex flex-col gap-2">
            {state.devices.map((device) => (
              <li key={device.id} className="rounded-xl bg-inset px-3 py-3">
                <div className="flex items-center gap-3">
                  <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-control text-ink-secondary">
                    <Smartphone size={15} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13.5px] font-medium text-ink">{device.name}</div>
                    <div className="text-[11.5px] text-ink-secondary">
                      {device.web ? `${t("remote.devices.browser")} · ` : ""}
                      {t("remote.devices.lastSeen", { when: relative(device.lastSeenAt) })}
                    </div>
                  </div>
                  <button
                    disabled={c.busy}
                    onClick={() => void c.act((companion) => companion.revoke(device.id))}
                    aria-label={t("remote.devices.remove", { name: device.name })}
                    className="shrink-0 rounded p-1.5 text-ink-secondary hover:bg-control hover:text-danger disabled:opacity-40"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
                {/* a browser-held token never gets desktop control */}
                {!device.web && <div className="mt-3 flex items-center justify-between gap-3 border-t border-hairline/30 pt-3">
                  <div>
                    <div className="text-[12px] text-ink">{t("remote.devices.allowView")}</div>
                    <div className="mt-0.5 text-[11px] text-ink-secondary">{t("remote.devices.allowViewDetail")}</div>
                  </div>
                  <Switch
                    checked={device.cloudDesktopAccess}
                    aria-label={t("remote.devices.viewAria", { name: device.name })}
                    disabled={c.busy}
                    onClick={() =>
                      void c.act((companion) =>
                        companion.cloudDesktop(device.id, !device.cloudDesktopAccess),
                      )
                    }
                  />
                </div>}
              </li>
            ))}
          </ul>
        )}
        {/* on by default; the switch stays for a laptop that should sleep */}
        <div className="mt-3 flex items-center justify-between gap-4 border-t border-hairline/30 pt-3">
          <div className="min-w-0">
            <div className="text-[13px] text-ink">{t("remote.keepAwake")}</div>
            <div className="mt-0.5 text-[11.5px] leading-relaxed text-ink-secondary">{t("remote.keepAwakeDetail")}</div>
          </div>
          <Switch
            checked={state.keepAwake}
            aria-label={t("remote.keepAwakeAria")}
            disabled={c.busy || !state.enabled}
            onClick={() => void c.act((companion) => companion.keepAwake(!state.keepAwake))}
          />
        </div>
      </Card>
    </div>
  );
}
