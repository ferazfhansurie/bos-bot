import { useState } from "react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { showToolCallsEnabled } from "@/lib/feature-flags";
import { t } from "@/lib/i18n";

/** The show/hide tool calls switch, shared by Settings and the room header.
 * It lives in the server config, so the choice follows the person to every
 * device they open BOS on; on until they turn it off. */
export function useToolCallsToggle() {
  const { state, dispatch } = useStore();
  const enabled = showToolCallsEnabled(state.config);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const toggle = async () => {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      const config: ConfigStatus = await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify({ features: { showToolCalls: !enabled } }),
      });
      dispatch({ type: "configStatus", config });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("settings.toolCalls.error"));
    } finally {
      setSaving(false);
    }
  };

  return { enabled, saving, error, toggle };
}
