// Synthetic connection states around the real panel and request lifecycle.
// No account, OAuth flow or user data is read by this fixture.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ReadinessPanel } from "../components/bot-settings/ReadinessPanel";
import { applySkin } from "../lib/skins";
import "../styles.css";

let mode = "pending";
let delay = false;
const originalFetch = window.fetch;
window.fetch = async (input, init) => {
  const path = String(input);
  if (path !== "/api/instances" && !/^\/api\/bots\/(atlas|juniper)\/overview$/.test(path)) return originalFetch(input, init);
  const captured = mode;
  const body = path === "/api/instances" ? { instances: [{
    instanceId: "fixture", driverKind: "codex", displayName: "fixture account",
    snapshot: { state: "available", authenticated: captured !== "signed-out" },
    capabilities: { composioMcp: true }, models: { default: "fixture", options: [] },
  }] } : { connections: { configured: true, authoritative: true,
    services: captured === "connected" ? ["gmail", "slack"] : ["gmail"],
    pending: captured === "pending" ? ["slack"] : [],
    reconnect: captured === "expired" ? ["slack"] : [],
  } };
  if (delay) await new Promise(resolve => setTimeout(resolve, 2500));
  // Deliberately ignore abort here: late completions must still be rejected
  // by the panel's identity/cancellation guards.
  return Response.json(captured === "offline" ? { error: "fixture unavailable" } : body, { status: captured === "offline" ? 503 : 200 });
};

function Fixture() {
  const [selected, setSelected] = useState("atlas");
  const [lastAction, setLastAction] = useState("");
  const [, update] = useState(0);
  return <main className="min-h-screen bg-panel p-6 text-ink">
    <h1 className="mb-3">isolated readiness verification</h1>
    <div className="mb-4 flex flex-wrap gap-2">
      {["pending", "connected", "expired", "signed-out", "offline"].map(value => <button key={value} className="rounded bg-control p-2" onClick={() => { mode = value; update(n => n + 1); }}>simulate {value}</button>)}
      <button className="rounded bg-control p-2" onClick={() => setSelected(value => value === "atlas" ? "juniper" : "atlas")}>switch bot</button>
      <label><input type="checkbox" onChange={event => { delay = event.target.checked; }} /> delay responses</label>
    </div>
    <p className="mb-3">selected: {selected} · fixture state: {mode} · opened: {lastAction || "none"}</p>
    <div className="max-w-md"><ReadinessPanel key={selected} active bot={{ id: selected, modelSelection: { instanceId: "fixture", model: "fixture" }, composio: true }} onAction={setLastAction} /></div>
  </main>;
}
applySkin("midnight");
const root = createRoot(document.getElementById("root")!);
root.render(<Fixture />);
if (import.meta.hot) import.meta.hot.dispose(() => { root.unmount(); window.fetch = originalFetch; });
