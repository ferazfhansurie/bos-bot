// Workspace-wide permission defaults. Per-bot levels stay on the bot (see
// ApprovalModeSelector) — this only decides where a bot starts, and whether an
// already-granted Full access survives a move to another engine.
import { useState } from "react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { t } from "@/lib/i18n";
import type { ApprovalMode } from "../../shared/approval-mode";
import { approvalModeOptions } from "./ApprovalModeSelector";
import { Card, SettingRow, Switch } from "./SettingsPrimitives";

/** Custom is one provider's config.toml (Codex only), so it cannot be a
 * workspace-wide starting point — offered only when it is already saved, so a
 * value set through the API still shows instead of an empty select. */
export function defaultModeChoices(saved: ApprovalMode) {
  return approvalModeOptions().filter((option) => option.mode !== "custom" || saved === "custom");
}

export function DefaultApprovalsSettings() {
  const { state, dispatch } = useStore();
  const defaultMode: ApprovalMode = state.config?.approvals?.defaultMode ?? "ask";
  const keepAcrossModelSwitch = state.config?.approvals?.keepAcrossModelSwitch === true;
  const [saving, setSaving] = useState<"defaultMode" | "keepAcrossModelSwitch" | null>(null);
  const [error, setError] = useState("");

  const save = async (
    field: "defaultMode" | "keepAcrossModelSwitch",
    approvals: NonNullable<ConfigStatus["approvals"]>,
  ) => {
    if (saving) return;
    setSaving(field);
    setError("");
    try {
      const config: ConfigStatus = await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify({ approvals }),
      });
      dispatch({ type: "configStatus", config });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("settings.approvals.error"));
    } finally {
      setSaving(null);
    }
  };

  return (
    <Card title={t("settings.approvals.title")} subtitle={t("settings.approvals.subtitle")}>
      <SettingRow
        title={t("settings.approvals.defaultMode.title")}
        subtitle={t("settings.approvals.defaultMode.subtitle")}
      >
        <select
          value={defaultMode}
          disabled={saving !== null}
          aria-label={t("settings.approvals.defaultMode.aria")}
          onChange={(event) => void save("defaultMode", { defaultMode: event.target.value as ApprovalMode })}
          className="min-h-8 w-full max-w-[240px] rounded-lg border border-hairline/40 bg-inset px-2.5 py-1.5 text-[13px] text-ink focus:border-focus disabled:cursor-wait disabled:opacity-50"
        >
          {defaultModeChoices(defaultMode).map((option) => (
            <option key={option.mode} value={option.mode}>{option.label}</option>
          ))}
        </select>
      </SettingRow>
      <SettingRow
        title={t("settings.approvals.keepAcrossModelSwitch.title")}
        subtitle={t("settings.approvals.keepAcrossModelSwitch.subtitle")}
        message={error ? <p role="alert" className="text-danger">{error}</p> : null}
      >
        <Switch
          checked={keepAcrossModelSwitch}
          aria-label={t("settings.approvals.keepAcrossModelSwitch.aria")}
          disabled={saving !== null}
          onClick={() => void save("keepAcrossModelSwitch", { keepAcrossModelSwitch: !keepAcrossModelSwitch })}
          className="disabled:cursor-wait disabled:opacity-50"
        />
      </SettingRow>
      <p className="text-[12px] leading-relaxed text-ink-secondary">{t("settings.approvals.help")}</p>
    </Card>
  );
}
