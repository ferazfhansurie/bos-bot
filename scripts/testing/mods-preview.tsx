import { useState } from "react";
import { createRoot } from "react-dom/client";
import { StoreProvider, useStore } from "../../src/state/store";
import { ModSurfaces, ModCommands } from "../../src/mods/ModSurfaces";
import { ModsSettings } from "../../src/mods/ModsSettings";
import { applySkin, readSkin } from "../../src/lib/skins";
import "../../src/styles.css";
function Preview() {
  const { state } = useStore(); const [settings, setSettings] = useState(false);
  const bot = state.bots.find(bot => bot.id === state.selectedId) ?? state.bots[0];
  return <main className="flex h-screen flex-col bg-app text-ink"><header className="flex items-center justify-between border-b border-hairline p-4"><span>BOS · {bot?.name ?? "Loading"}</span><button onClick={() => setSettings(!settings)}>{settings ? "Back to conversation" : "Mods settings"}</button></header>
    {settings ? <section className="mx-auto w-full max-w-3xl overflow-auto p-6"><ModsSettings /></section> : bot ? <div className="flex min-h-0 flex-1"><section className="flex min-w-0 flex-1 flex-col"><ModSurfaces botId={bot.id} surface="chip" /><div className="flex-1 p-8"><h1 className="text-xl">{bot.name}</h1><p className="mt-3 text-ink-secondary">{bot.messages.at(-1)?.text ?? "Your conversation and desktop mods appear here."}</p></div><ModCommands botId={bot.id} threadId={bot.threadId} /><ModSurfaces botId={bot.id} surface="band" /></section><ModSurfaces botId={bot.id} surface="panel" /></div> : null}
  </main>;
}
applySkin(readSkin());
createRoot(document.getElementById("root")!).render(<StoreProvider><Preview /></StoreProvider>);
