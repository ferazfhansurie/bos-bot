import { useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { api, useStore } from "@/state/store";
import { Card } from "./SettingsPrimitives";

/** Another BOS server's bots in this sidebar, with full control. The other
 * server makes a pairing code with owner access; this server redeems it and
 * keeps the session (server/homes.ts). */
export function LinkedServersCard() {
  const { state } = useStore();
  const homes = state.homes ?? [];
  const [address, setAddress] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);

  const changed = () => window.dispatchEvent(new Event("bos:homes-changed"));
  const botsOn = (id: string) => state.bots.filter((bot) => bot.homeLink?.id === id);

  async function add(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/api/homes", { method: "POST", body: JSON.stringify({ address, code }), timeoutMs: 45_000 });
      setAddress("");
      setCode("");
      changed();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setError(null);
    try {
      await api(`/api/homes/${encodeURIComponent(id)}`, { method: "DELETE" });
      changed();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function rename() {
    if (!renaming) return;
    const next = renaming;
    setRenaming(null);
    try {
      await api(`/api/homes/${encodeURIComponent(next.id)}`, { method: "PATCH", body: JSON.stringify({ name: next.name }) });
      changed();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <Card
      title="Other servers"
      subtitle="Show another BOS server's bots in your sidebar and run them like your own. On that server, make a pairing code with full access, then paste its address or pairing link here."
    >
      {homes.length > 0 && (
        <ul className="mb-4 divide-y divide-hairline/40" data-linked-servers>
          {homes.map((home) => {
            const bots = botsOn(home.id);
            const online = home.online === true;
            return (
              <li key={home.id} className="flex items-center gap-3 py-2.5">
                <span className={online ? "h-2 w-2 shrink-0 rounded-full bg-green-500" : "h-2 w-2 shrink-0 rounded-full bg-ink-tertiary/50"} aria-hidden />
                <div className="min-w-0 flex-1">
                  {renaming?.id === home.id ? (
                    <input
                      autoFocus
                      className="w-full rounded-md bg-control px-2 py-1 text-[14px] text-ink outline-none"
                      value={renaming.name}
                      onChange={(e) => setRenaming({ id: home.id, name: e.target.value })}
                      onBlur={() => void rename()}
                      onKeyDown={(e) => { if (e.key === "Enter") void rename(); if (e.key === "Escape") setRenaming(null); }}
                    />
                  ) : (
                    <button type="button" className="truncate text-left text-[14px] font-medium text-ink hover:underline" onClick={() => setRenaming({ id: home.id, name: home.name })} title="Rename">
                      {home.name}
                    </button>
                  )}
                  <div className="truncate text-[12px] text-ink-secondary">
                    {home.online === undefined ? "Connecting…" : online ? `${bots.length} ${bots.length === 1 ? "bot" : "bots"} in your sidebar` : "Asleep · its bots wake when it's back"} · {home.origin}
                  </div>
                </div>
                <button type="button" className="rounded-md p-1.5 text-ink-secondary hover:bg-control hover:text-ink" onClick={() => void remove(home.id)} aria-label={`Remove ${home.name}`}>
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <form className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_160px_auto]" onSubmit={(e) => void add(e)}>
        <input
          className="rounded-lg bg-control px-3 py-2 text-[14px] text-ink outline-none placeholder:text-ink-tertiary"
          placeholder="Address or pairing link"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <input
          className="rounded-lg bg-control px-3 py-2 font-mono text-[14px] text-ink outline-none placeholder:text-ink-tertiary"
          placeholder="Pairing code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <button
          type="submit"
          disabled={busy || !address.trim()}
          className="inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2 text-[14px] font-medium text-white disabled:opacity-40"
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          Add
        </button>
      </form>
      {error && <p className="mt-2 text-[12px] text-red-500" role="alert">{error}</p>}
    </Card>
  );
}
