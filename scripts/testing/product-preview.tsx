import { useState } from "react";
import { createRoot } from "react-dom/client";
import { StoreProvider } from "../../src/state/store";
import { DesktopCapabilitiesProvider } from "../../src/components/DesktopCapabilities";
import { PlansCard } from "../../src/components/PlansCard";
import { ProductBanner } from "../../src/components/ProductBanner";
import { SupportDialog } from "../../src/components/SupportDialog";
import { FeedbackButtons, GOOD, BAD } from "../../src/components/TurnActions";
import { EnginesBeat } from "../../src/components/onboarding/beats/EnginesBeat";
import { applySkin } from "../../src/lib/skins";
import "../../src/styles.css";

function Preview() {
  const [support, setSupport] = useState(false);
  const [active, setActive] = useState({ good: false, bad: false });
  return <main className="mx-auto max-w-3xl space-y-5 p-5 text-ink">
    <h1 className="text-xl font-semibold">Isolated product UI fixture</h1>
    <ProductBanner />
    <PlansCard />
    <button className="ui-button" onClick={() => setSupport(true)}>Open support</button>
    <SupportDialog open={support} onClose={() => setSupport(false)} />
    <section aria-label="Sample response"><p>Synthetic response; never shared with feedback.</p><div className="mt-2 flex gap-2"><FeedbackButtons active={active} onReact={emoji => setActive(previous => emoji === GOOD ? { ...previous, good: !previous.good } : emoji === BAD ? { ...previous, bad: !previous.bad } : previous)} /></div></section>
    <section aria-label="Engine onboarding"><EnginesBeat inline onNext={() => {}} setMascot={() => {}} bump={() => {}} /></section>
  </main>;
}
applySkin("midnight");
const root = createRoot(document.getElementById("root")!);
root.render(<StoreProvider><DesktopCapabilitiesProvider><Preview /></DesktopCapabilitiesProvider></StoreProvider>);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
