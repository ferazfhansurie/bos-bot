import { useEffect, useState } from "react";
import { ModFrame } from "./ModFrame";
import { modsDesktop, useMods } from "./use-mods";
export function ModSurfaces({ botId, surface }: { botId: string; surface: "panel" | "band" | "chip" }) {
  const mods = useMods();
  if (!modsDesktop()) return null;
  const active = mods.filter(mod => mod.enabled && mod.botId === botId && mod.manifest.surfaces.includes(surface));
  if (!active.length) return null;
  return <div data-mod-surface={surface} className={surface === "panel" ? "w-80 shrink-0 overflow-auto border-s border-hairline bg-panel p-3" : "flex flex-wrap gap-2 px-3 py-1"}>
    {active.map(mod => <div key={mod.manifest.id} className={surface === "chip" ? "" : "w-full"}>{surface === "panel" && <p className="mb-2 text-sm font-medium">{mod.manifest.name}</p>}<ModFrame key={mod.revision} mod={mod} botId={botId} surface={surface} /></div>)}
  </div>;
}
export function ModCommands({ botId, threadId }: { botId: string; threadId: string }) {
  const mods = useMods(); const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => { setSelected(null); }, [botId, threadId]);
  useEffect(() => {
    const run = (event: Event) => { const detail = (event as CustomEvent).detail; if (detail.botId === botId) setSelected(detail.id); };
    window.addEventListener("bos-mod-command", run); return () => window.removeEventListener("bos-mod-command", run);
  }, [botId]);
  if (!modsDesktop()) return null;
  const commands = mods.filter(mod => mod.enabled && mod.botId === botId && mod.manifest.surfaces.includes("command"));
  const current = commands.find(mod => mod.manifest.id === selected);
  return <div className="px-3">{commands.length > 0 && <div className="flex gap-2">{commands.map(mod => <button key={mod.manifest.id} className="rounded-lg px-2 py-1 text-xs text-ink-secondary hover:bg-raised" onClick={() => setSelected(mod.manifest.id)}>/{mod.manifest.id}</button>)}</div>}
    {current && <section className="my-2 rounded-xl border border-hairline p-2"><div className="flex justify-between text-xs"><span>/{current.manifest.id}</span><button onClick={() => setSelected(null)}>Close</button></div><ModFrame mod={current} botId={botId} surface="command" /></section>}
  </div>;
}
