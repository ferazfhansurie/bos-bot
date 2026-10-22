import { useRef, useState } from "react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { SettingRow, Switch } from "./SettingsPrimitives";
import { setAnalyticsEnabled } from "@/lib/analytics";

export function AnonymousUsageSettings() {
  const { state, dispatch } = useStore();
  const [pending, setPending] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const saving = useRef(false);
  const disabledByEnv = state.config?.anonymousUsage?.disabledByEnv === true;
  const save = async (enabled: boolean) => {
    if (saving.current) return;
    saving.current = true;
    setPending(enabled);
    setError("");
    try {
      const config = await api<ConfigStatus>("/api/config", {
        method: "PATCH", body: JSON.stringify({ anonymousUsage: { enabled } }),
      });
      dispatch({ type: "configStatus", config });
      setAnalyticsEnabled(config.anonymousUsage?.enabled !== false && config.anonymousUsage?.disabledByEnv !== true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save anonymous usage setting.");
    } finally {
      saving.current = false;
      setPending(null);
    }
  };
  return (
    <SettingRow title="share anonymous usage counts" subtitle={
      <>Sends a random install ID, app version, platform, architecture, detected Claude/Codex engine names,
        bot and room counts, largest room human and bot counts, and a first-run or daily event to bos.aihlete.com.
        When available, includes update state and crash count. The daily ping is sent at most once per 24 hours. Also sends batched activation events and counts
        to bosbot.my every minute and when BOS quits. No chat, file names, paths, prompts or tokens.
        If you type an onboarding email, it is sent separately to match a consented signup.
        {disabledByEnv && " Disabled by BOS_NO_PING=1 on this server."}</>
    } message={error ? <span role="alert" className="text-danger">{error}</span> : undefined}>
      <Switch aria-label="share anonymous usage counts"
        checked={!disabledByEnv && (pending ?? state.config?.anonymousUsage?.enabled !== false)}
        disabled={pending !== null || disabledByEnv || !state.config}
        onClick={() => void save(!(state.config?.anonymousUsage?.enabled !== false))} />
    </SettingRow>
  );
}
