import { useState } from "react";
import { createRoot } from "react-dom/client";
import { PageEditor } from "../../src/components/pages/PageEditor";
import { pageApi } from "../../src/components/pages/page-api";
import { applySkin } from "../../src/lib/skins";
import { setAnalyticsEnabled } from "../../src/lib/analytics";
import "../../src/styles.css";
const showError = (error: unknown) => { const pre = document.createElement("pre"); pre.setAttribute("role", "alert"); pre.textContent = String(error); document.body.append(pre); };
window.addEventListener("error", event => showError(event.error ?? event.message));
window.addEventListener("unhandledrejection", event => showError(event.reason));
setAnalyticsEnabled(false); applySkin("midnight");
const { bots } = await fetch("/api/bots?messages=0").then(r => r.json());
const bot = bots.find((b: { name: string }) => b.name === "Page fixture");
if (!bot) throw new Error("fixture bot missing");
const page = await pageApi.create(bot.id, { title: "Launch notes", markdown: "## A page we can work on together\n\nWrite, review and refine a document with your bot. Every block keeps its author and comments.\n\n- [x] Create a document\n- [ ] Review the launch plan\n\n> Keep the work in one place.\n\n| Milestone | Status |\n| --- | --- |\n| Draft | Ready |\n| Review | Next |" });
function Fixture() {
  const [ref, setRef] = useState(page.id);
  const [request, setRequest] = useState("");
  return <div style={{ height: "100vh", display: "flex", background: "var(--color-panel)" }}><section style={{ width: 310, borderRight: "1px solid #eee", padding: 25, fontFamily: "system-ui", color: "var(--color-ink)" }}><b>Conversation</b><p style={{ marginTop: 35, fontSize: 14 }}>Make a page for the launch plan.</p><p style={{ marginTop: 25, fontSize: 14 }}>The document is open on the right. You can write here or ask your bot to change it.</p><output data-testid="page-request">{request}</output></section><PageEditor botId={bot.id} threadId={bot.threadId} pageId={ref} onPage={id => setRef(id)} onAsk={setRequest} /></div>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
