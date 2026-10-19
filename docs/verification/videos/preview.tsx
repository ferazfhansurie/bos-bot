import { useState } from "react";
import { createRoot } from "react-dom/client";
import { VideoEditor } from "../../../src/components/videos/VideoEditor";
import { applySkin } from "../../../src/lib/skins";
import { setAnalyticsEnabled } from "../../../src/lib/analytics";
import "../../../src/styles.css";
// The video editor mounted beside a fake conversation column. `?w=520` sets the
// editor panel width (a narrow side tab); without it the panel fills the rest.
// Seed media and timelines through the owner api (see docs/verification/videos.md).
const showError = (error: unknown) => { const pre = document.createElement("pre"); pre.setAttribute("role", "alert"); pre.textContent = String(error); document.body.append(pre); };
window.addEventListener("error", event => showError(event.error ?? event.message));
window.addEventListener("unhandledrejection", event => showError(event.reason));
setAnalyticsEnabled(false); applySkin("midnight");
const { bots } = await fetch("/api/bots?messages=0").then(r => r.json());
const bot = bots.find((b: { name: string }) => b.name === "Pepper" || b.name === "Video fixture");
if (!bot) throw new Error("fixture bot missing");
const params = new URLSearchParams(location.search);
const width = Number(params.get("w")) || undefined;
function Fixture() {
  const [ref, setRef] = useState<string | undefined>(params.get("v") ?? undefined);
  const [request, setRequest] = useState("");
  return <div style={{ height: "100vh", display: "flex", background: "var(--color-app)" }}>
    <section style={{ flex: 1, minWidth: 280, borderRight: "1px solid rgb(255 255 255 / .08)", padding: 25, fontFamily: "system-ui", color: "var(--color-ink)" }}>
      <b>Conversation</b><p style={{ marginTop: 35, fontSize: 14 }}>cut me a reel from these clips.</p>
      <output data-testid="video-request" style={{ display: "block", marginTop: 25, fontSize: 13, opacity: .7 }}>{request}</output>
    </section>
    <div style={{ width: width ?? "72%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <VideoEditor botId={bot.id} threadId={bot.threadId ?? "fixture-thread"} videoId={ref} active onVideo={id => setRef(id)} onList={() => setRef(undefined)} onAsk={text => setRequest(text)} />
    </div>
  </div>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
