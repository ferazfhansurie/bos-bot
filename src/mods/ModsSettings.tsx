import { useRef, useState } from "react";
import { api, useStore } from "@/state/store";
import { track } from "@/lib/analytics";
import { modBundle, type ModBundle, type ModRecord } from "../../shared/mods";
import { Card } from "@/components/SettingsPrimitives";
import { modsDesktop, refreshMods, useMods, type ModSummary } from "./use-mods";
export function ModsSettings() {
  const mods = useMods(); const { state } = useStore();
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const [review, setReview] = useState<ModSummary | null>(null);
  const [files, setFiles] = useState<ModRecord | null>(null);
  const [incoming, setIncoming] = useState<ModBundle | null>(null);
  const [botId, setBotId] = useState(state.bots.find(bot => bot.id === state.selectedId)?.id ?? state.bots[0]?.id ?? "");
  const input = useRef<HTMLInputElement>(null);
  const run = (action: () => Promise<void>) => { setBusy(true); setError(""); void action().catch(() => setError("That change could not finish. Check the mod files and try again.")).finally(() => { setBusy(false); void refreshMods(); }); };
  const toggle = (mod: ModSummary, enabled: boolean) => run(async () => {
    await api(`/api/mods/${mod.manifest.id}/enabled`, { method: "POST", body: JSON.stringify({ enabled, revision: mod.revision }) });
    if (enabled) track("mod_enabled"); setReview(null);
  });
  if (!modsDesktop()) return <p className="text-sm text-ink-secondary">Mods are available on desktop.</p>;
  return <div className="space-y-4"><p className="text-sm text-ink-secondary">Ask a bot to build a mod for your panels, composer, status chips or slash commands. Review permissions here to turn it on.</p>
    {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
    <button className="rounded-xl border border-hairline px-3 py-2 text-sm" disabled={busy} onClick={() => input.current?.click()}>Import .bosmod</button>
    <input ref={input} hidden type="file" accept=".bosmod,application/json" onChange={event => { const file = event.target.files?.[0]; if (!file) return; event.target.value = ""; run(async () => { if (file.size > 600_000) throw new Error("too large"); setIncoming(modBundle.parse(JSON.parse(await file.text()))); }); }} />
    {incoming && <Card title={`Import ${incoming.manifest.name}`}><p className="text-sm">Permissions: {incoming.manifest.permissions.join(", ") || "none"}. The mod will be imported off.</p>
      <label className="block py-2 text-sm">Bot <select aria-label="Mod bot" value={botId} onChange={e => setBotId(e.target.value)} className="ms-2 rounded bg-panel p-2">{state.bots.filter(bot => !bot.hidden).map(bot => <option key={bot.id} value={bot.id}>{bot.name}</option>)}</select></label>
      <button disabled={busy || !botId} onClick={() => run(async () => { await api("/api/mods/import", { method: "POST", body: JSON.stringify({ bundle: incoming, botId }) }); setIncoming(null); })}>Import off</button><button className="ms-4" onClick={() => setIncoming(null)}>Cancel</button>
    </Card>}
    {mods.length === 0 && <p className="text-sm text-ink-secondary">No mods yet. Try “add a panel that shows today’s leads.”</p>}
    {mods.map(mod => <Card key={mod.manifest.id} title={mod.manifest.name} subtitle={mod.manifest.description}>
      <p className="text-xs text-ink-secondary">{mod.manifest.surfaces.join(", ")} · v{mod.manifest.version}</p>
      <p className="my-2 text-sm">Permissions: {mod.manifest.permissions.join(", ") || "none"}</p>
      {!mod.enabled && mod.requestedEnabled && <p className="text-sm">Paused by safe mode or workspace configuration.</p>}
      <div className="flex flex-wrap gap-4 text-sm"><button role="switch" aria-checked={mod.enabled} aria-label={`Enable ${mod.manifest.name}`} disabled={busy} onClick={() => mod.enabled ? toggle(mod, false) : setReview(mod)}>{mod.enabled ? "On" : "Off"}</button>
        <button disabled={busy} onClick={() => run(async () => { const data = await api<{ mod: ModRecord }>(`/api/mods/${mod.manifest.id}`); setFiles(data.mod); })}>Show files</button>
        <button disabled={busy} onClick={() => run(async () => { const bundle = await api<ModBundle>(`/api/mods/${mod.manifest.id}/export`); const url = URL.createObjectURL(new Blob([JSON.stringify(bundle)], { type: "application/vnd.bosmod+json" })); const a = document.createElement("a"); a.href = url; a.download = `${mod.manifest.id}.bosmod`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); })}>Export</button>
        <button disabled={busy} onClick={() => run(async () => { await api(`/api/mods/${mod.manifest.id}`, { method: "DELETE" }); if (files?.manifest.id === mod.manifest.id) setFiles(null); })}>Delete</button>
      </div>
      {review?.manifest.id === mod.manifest.id && <div className="mt-3 rounded-xl bg-raised p-3 text-sm"><p>Enable {mod.manifest.name} with these permissions: {mod.manifest.permissions.join(", ") || "none"}?</p><p className="my-2 text-ink-secondary">Thread reads share this bot’s recent conversation text. A bot request (bots:ask) lets this mod ask {state.bots.find(bot => bot.id === mod.botId)?.name ?? "this bot"} anything, and the bot can read everything it can see, including memory and past chats, and pass it back to the mod. It can’t hand work to teammates or change memory, skills or mods. App actions still need your approval.</p><button disabled={busy} onClick={() => toggle(review, true)}>Enable mod</button><button className="ms-4" onClick={() => setReview(null)}>Cancel</button></div>}
    </Card>)}
    {files && <Card title={`${files.manifest.name} files`}><button className="text-sm" onClick={() => setFiles(null)}>Close files</button>{Object.entries({ "manifest.json": JSON.stringify(files.manifest, null, 2), ...files.files }).map(([name, text]) => <details key={name} className="my-2"><summary>{name}</summary><pre className="max-h-80 overflow-auto whitespace-pre-wrap text-xs">{text}</pre></details>)}</Card>}
  </div>;
}
