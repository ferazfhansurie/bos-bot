import { useRef, useState } from "react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { t } from "@/lib/i18n";
import { Card } from "./SettingsPrimitives";

export function ThreadConcurrencySettings() {
  const { state, dispatch } = useStore();
  const confirmed = state.config?.threads?.maxConcurrentPerBot ?? 3;
  // Default on, matching the server: an absent field is a config written
  // before this setting existed, not an opt-out.
  const sharedFolder = state.config?.threads?.parallelProjectFolder ?? true;
  const [pending, setPending] = useState<number | null>(null);
  const [pendingDays, setPendingDays] = useState<number | null>(null);
  const [pendingShared, setPendingShared] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const saving = useRef(false);
  // The threads section is strict and maxConcurrentPerBot is required, so
  // every patch carries the limit even when only the toggle moved.
  const save = async (limit: number, parallelProjectFolder: boolean, autoSettleDays = state.config?.threads?.autoSettleDays ?? 3) => {
    if (saving.current) return;
    saving.current = true;
    if (autoSettleDays !== (state.config?.threads?.autoSettleDays ?? 3)) setPendingDays(autoSettleDays);
    if (limit !== confirmed) setPending(limit);
    if (parallelProjectFolder !== sharedFolder) setPendingShared(parallelProjectFolder);
    setError("");
    try {
      const config: ConfigStatus = await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify({ threads: { ...state.config?.threads, maxConcurrentPerBot: limit, parallelProjectFolder, autoSettleDays } }),
      });
      dispatch({ type: "configStatus", config });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("settings.threads.error"));
    } finally {
      saving.current = false;
      setPending(null);
      setPendingShared(null);
      setPendingDays(null);
    }
  };
  const busy = pending !== null || pendingShared !== null || pendingDays !== null;
  return (
    <Card title={t("settings.threads.title")} subtitle={t("settings.threads.subtitle")}>
      <label htmlFor="thread-concurrency" className="block text-[13px] font-medium text-ink">{t("settings.threads.label")}</label>
      <select id="thread-concurrency" value={pending ?? confirmed} disabled={busy}
        aria-describedby="thread-concurrency-help"
        onChange={(event) => void save(Number(event.target.value), sharedFolder)}
        className="mt-2 rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink disabled:opacity-50">
        {Array.from({ length: 10 }, (_, i) => i + 1).map((limit) => <option key={limit} value={limit}>{limit}</option>)}
      </select>
      <p id="thread-concurrency-help" className="mt-2 text-[12px] leading-relaxed text-ink-secondary">{t("settings.threads.help")}</p>
      <label htmlFor="thread-shared-folder" className="mt-4 flex items-start gap-2 text-[13px] font-medium text-ink">
        <input id="thread-shared-folder" type="checkbox" checked={pendingShared ?? sharedFolder} disabled={busy}
          aria-describedby="thread-shared-folder-help"
          onChange={(event) => void save(confirmed, event.target.checked)}
          className="mt-[2px] disabled:opacity-50" />
        <span>{t("settings.threads.sharedFolder.label")}</span>
      </label>
      <p id="thread-shared-folder-help" className="mt-2 text-[12px] leading-relaxed text-ink-secondary">{t("settings.threads.sharedFolder.help")}</p>
      <label className="mt-4 block text-[13px] font-medium text-ink" htmlFor="thread-settle-days">Close idle threads after</label>
      <select id="thread-settle-days" value={pendingDays ?? state.config?.threads?.autoSettleDays ?? 3} disabled={busy}
        onChange={event => void save(confirmed, sharedFolder, Number(event.target.value))}
        className="mt-2 rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink">
        {[0, 1, 3, 7, 14, 30].map(days => <option key={days} value={days}>{days === 0 ? "Off" : `${days} days`}</option>)}
      </select>
      <p className="mt-2 text-[12px] text-ink-secondary">Keeps unread replies, questions, approvals and running work open. Closed threads remain in All threads.</p>
      {busy && <p role="status" className="mt-2 text-[12px] text-ink-secondary">{t("settings.threads.saving")}</p>}
      {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
    </Card>
  );
}
