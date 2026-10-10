// Settings → General: bots from linked Macs that the owner removed from this
// list. They still live on the other Mac; "Add back" lists them again here.
import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { api } from "@/state/store";
import { Card } from "./SettingsPrimitives";

interface RemovedBot { homeId: string; homeName: string; remoteBotId: string; name: string; removedAt: number }

export function RemovedRemoteBots() {
  const [removed, setRemoved] = useState<RemovedBot[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api<{ removedBots?: RemovedBot[] }>("/api/multiplayer/links")
    .then((result) => setRemoved(Array.isArray(result?.removedBots) ? result.removedBots : []))
    .catch(() => setRemoved([])), []);
  useEffect(() => { void load(); }, [load]);
  if (removed.length === 0) return null;
  const addBack = async (bot: RemovedBot) => {
    const key = `${bot.homeId}/${bot.remoteBotId}`;
    setBusy(key);
    setError(null);
    try {
      await api(`/api/multiplayer/links/${encodeURIComponent(bot.homeId)}/bots/${encodeURIComponent(bot.remoteBotId)}/add-back`, { method: "POST", body: "{}" });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Card title="Removed bots" subtitle="Bots from linked Macs you removed from your list. They still live on their owner's Mac.">
      <ul className="divide-y divide-hairline/30">
        {removed.map((bot) => {
          const key = `${bot.homeId}/${bot.remoteBotId}`;
          return (
            <li key={key} className="flex items-center justify-between gap-3 py-2">
              <div className="min-w-0">
                <div className="truncate text-[13px] text-ink">{bot.name}</div>
                <div className="truncate text-[11.5px] text-ink-secondary">on {bot.homeName}'s Mac</div>
              </div>
              <button type="button" disabled={busy !== null} onClick={() => void addBack(bot)}
                className="flex items-center gap-1.5 rounded-lg border border-hairline/40 px-2.5 py-1 text-[12.5px] text-ink hover:bg-raised/70 disabled:opacity-50">
                {busy === key && <Loader2 size={13} className="animate-spin" />}Add back
              </button>
            </li>
          );
        })}
      </ul>
      {error && <p className="mt-2 text-[12px] text-danger">{error}</p>}
    </Card>
  );
}
