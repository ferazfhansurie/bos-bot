// Settings → Usage, "xAI · voice": credits left (needs a management key),
// voice minutes from our own call tally, and when it was last read. The
// management key is write-only from here: it goes to the desktop shell's
// encrypted store (or the server's config in a browser) and never comes back.
import { useState } from "react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { createUsageFeed, useFeed } from "@/lib/usage-feed";
import { ago, barTone, formatCents, formatSeconds, type XaiUsage } from "@/lib/usage-chips";

export const xaiUsageFeed = createUsageFeed<XaiUsage>("bos.usage.xai", {
  load: () => api<XaiUsage>("/api/xai-usage"),
});

export function useXaiUsage() {
  return useFeed(xaiUsageFeed);
}

function ManagementKeyForm({ onDone }: { onDone: () => void }) {
  const { dispatch } = useStore();
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (value: string) => {
    setSaving(true);
    setError(null);
    try {
      const status: ConfigStatus = window.ogb?.setCredential
        ? await window.ogb.setCredential("xaiManagementKey", value)
        : await api("/api/config", { method: "PUT", body: JSON.stringify({ xai: { managementKey: value } }) });
      dispatch({ type: "configStatus", config: status });
      setKey("");
      void xaiUsageFeed.refresh();
      onDone();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  };
  return (
    <form
      className="space-y-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        if (key.trim()) void save(key.trim());
      }}
    >
      <div className="flex gap-2">
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={key}
          onChange={(event) => setKey(event.target.value)}
          placeholder="xAI management key"
          aria-label="xAI management key"
          className="min-w-0 flex-1 rounded-lg border border-hairline/60 bg-transparent px-2 py-1 text-[12px] text-ink outline-none focus:border-accent"
        />
        <button type="submit" disabled={saving || !key.trim()} className="rounded-lg bg-accent px-2.5 py-1 text-[12px] font-medium text-white disabled:opacity-50">
          {saving ? "Checking…" : "Save"}
        </button>
      </div>
      <div className="text-[11px] text-ink-secondary">
        Reads prepaid credits only. Create one at{" "}
        <a href="https://console.x.ai" target="_blank" rel="noreferrer" className="underline">console.x.ai</a> → Management keys.
      </div>
      {error && <div className="text-[11px] text-red-500">{error}</div>}
    </form>
  );
}

export function XaiVoiceTile() {
  const { state } = useStore();
  const { value, fetchedAt, failed } = useXaiUsage();
  const [editing, setEditing] = useState(false);
  const keySaved = state.config?.xai?.managementConfigured === true;
  const credits = value?.credits.configured ? value.credits : null;
  const voice = value?.voice;
  const spent = credits?.credits && credits.credits.purchasedCents > 0
    ? Math.min(100, (credits.credits.usedCents / credits.credits.purchasedCents) * 100)
    : null;
  return (
    <div className="space-y-3 rounded-xl border border-hairline/40 p-3" data-testid="xai-voice-card">
      <div className="text-[13px] font-medium text-ink">xAI · voice</div>
      {credits?.credits ? (
        <div className="space-y-1">
          <div className="flex justify-between text-[12px] text-ink-secondary">
            <span>Credits left</span>
            <span className="tabular-nums text-ink">{formatCents(credits.credits.remainingCents)}</span>
          </div>
          {spent !== null && (
            <div className="h-1.5 overflow-hidden rounded-full bg-hairline/40">
              <div className={`h-full rounded-full ${barTone(spent)}`} style={{ width: `${spent}%` }} />
            </div>
          )}
          <div className="text-[11px] text-ink-secondary">
            {formatCents(credits.credits.usedCents)} used of {formatCents(credits.credits.purchasedCents)} this cycle
            {credits.credits.voiceSeconds > 0 && ` · xAI billed ${formatSeconds(credits.credits.voiceSeconds)} of voice (${formatCents(credits.credits.voiceCents)})`}
          </div>
        </div>
      ) : credits?.error ? (
        <div className="text-[12px] text-ink-secondary">Couldn't read credits: {credits.error}</div>
      ) : null}
      <div className="space-y-0.5">
        <div className="flex justify-between text-[12px] text-ink-secondary">
          <span>Voice calls this month</span>
          <span className="tabular-nums text-ink">
            {voice ? `${voice.calls} · ${formatSeconds(voice.seconds)}` : failed ? "Unavailable" : "Loading…"}
          </span>
        </div>
        {voice && voice.today.calls > 0 && (
          <div className="text-[11px] text-ink-secondary">Today: {voice.today.calls} · {formatSeconds(voice.today.seconds)}</div>
        )}
        {voice && voice.unmeasured > 0 && (
          <div className="text-[11px] text-ink-secondary">{voice.unmeasured} without a length yet (in progress, or from a phone)</div>
        )}
      </div>
      {editing ? (
        <ManagementKeyForm onDone={() => setEditing(false)} />
      ) : (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className={keySaved ? "text-[11px] text-ink-secondary hover:underline" : "text-[12px] text-accent hover:underline"}
        >
          {keySaved ? "Change management key" : "Add management key to see credits left"}
        </button>
      )}
      <div className="text-[11px] text-ink-secondary">
        {failed && fetchedAt !== null ? `Offline · last read ${ago(fetchedAt)}` : `Refreshed ${ago(fetchedAt)}`}
      </div>
    </div>
  );
}
