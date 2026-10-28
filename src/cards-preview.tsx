// Dev gallery for the bos bot 3.0 cards, like onboarding-preview.html: every
// card example and every connect-card state, in midnight and daylight under
// liquid glass, with
// reduced motion and reduced transparency switchable. Served by Vite in dev
// at /cards-preview.html; not part of the packaged app. Taps don't reach a
// bot here; the page shows the message a bot would have received.
//
// ?skin=midnight|daylight|both  ?only=<n> (one example, for shots)
// ?connect=<n> (one connect state)  ?width=<px>  ?reduced=1  ?solid=1
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ConnectorCardView, CONNECTOR_PREVIEWS } from "@/components/ConnectorCard";
import { SmartUi, type SmartUiTheme } from "@/openui/SmartUi";
import { CARD_EXAMPLES } from "@/openui/card-examples";
import "./styles.css";

type Skin = "midnight" | "daylight";
const SKINS: Skin[] = ["midnight", "daylight"];
const scheme = (skin: Skin): SmartUiTheme => (skin === "midnight" ? "dark" : "light");

function fromUrl() {
  const p = new URLSearchParams(location.search);
  const num = (key: string) => (p.has(key) ? Number(p.get(key)) : null);
  const skin = p.get("skin");
  return {
    skins: skin === "both" ? SKINS : [skin === "daylight" ? "daylight" : "midnight"] as Skin[],
    only: num("only"),
    connect: num("connect"),
    width: num("width") ?? 560,
    reduced: p.get("reduced") === "1",
    solid: p.get("solid") === "1",
  };
}

function Column({ skin, only, connect, width, onSent }: { skin: Skin; only: number | null; connect: number | null; width: number; onSent: (text: string) => void }) {
  const examples = connect !== null ? [] : only !== null ? CARD_EXAMPLES.slice(only, only + 1) : CARD_EXAMPLES;
  const previews = only !== null ? [] : connect !== null ? CONNECTOR_PREVIEWS.slice(connect, connect + 1) : CONNECTOR_PREVIEWS;
  return (
    <div data-skin={skin} className="min-w-0 rounded-xl bg-app p-5 text-ink" style={{ width }}>
      {examples.map((ex, i) => (
        <section key={`${ex.name}-${i}`} data-shot={`card-${only ?? i}`} className="mb-6">
          <p className="mb-2 text-[12px] text-ink-secondary">{ex.name} · {ex.title}</p>
          <SmartUi
            code={ex.code}
            streaming={false}
            theme={scheme(skin)}
            cards
            onAssistant={onSent}
            onOpenUrl={(url) => onSent(`open ${url}`)}
            fallback={<p className="text-[13px] text-danger">couldn't draw this</p>}
          />
        </section>
      ))}
      {previews.map(({ title, ...props }, i) => (
        <section key={title} data-shot={`connect-${connect ?? i}`} className="mb-6">
          <p className="mb-2 text-[12px] text-ink-secondary">Connect · {title}</p>
          <ConnectorCardView {...props} onAction={onSent} onConnect={() => onSent("(connect)")} />
        </section>
      ))}
    </div>
  );
}

function Preview() {
  const initial = fromUrl();
  const [reduced, setReduced] = useState(initial.reduced);
  const [solid, setSolid] = useState(initial.solid);
  const [sent, setSent] = useState<string | null>(null);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.v3 = "";
    root.dataset.liquidGlass = "";
    root.dataset.skin = initial.skins[0]!;
    root.dataset.reducedMotion = reduced ? "true" : "false";
    if (solid) root.dataset.reduceTransparency = "";
    else delete root.dataset.reduceTransparency;
  }, [initial.skins, reduced, solid]);

  return (
    <div data-skin={initial.skins[0]} className="min-h-screen bg-app p-6 text-ink">
      <header className="mb-5 flex flex-wrap items-center gap-3 text-[13px] text-ink-secondary">
        <h1 className="mr-2 text-[18px] font-semibold text-ink">Cards</h1>
        <label className="flex items-center gap-1.5"><input type="checkbox" checked={reduced} onChange={(e) => setReduced(e.target.checked)} /> Reduced motion</label>
        <label className="flex items-center gap-1.5"><input type="checkbox" checked={solid} onChange={(e) => setSolid(e.target.checked)} /> Reduced transparency</label>
        <span className="ml-auto">{sent ? `would send: ${sent}` : `${CARD_EXAMPLES.length} cards · ${CONNECTOR_PREVIEWS.length} connect states`}</span>
      </header>
      <div className="flex flex-wrap items-start gap-6">
        {initial.skins.map((skin) => (
          <Column key={skin} skin={skin} only={initial.only} connect={initial.connect} width={initial.width} onSent={setSent} />
        ))}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><Preview /></StrictMode>);
