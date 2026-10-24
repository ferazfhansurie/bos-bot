// Disposable control-omb ui entry for WhatsApp bot access. Only the owner chat
// list is synthetic; per-bot policy GET/PUT hit the real fixture server.
import { createRoot } from "react-dom/client";
import { StoreProvider } from "../../src/state/store";
import { WhatsAppPermissions } from "../../src/components/WhatsAppPermissions";
import { setAnalyticsEnabled, setEmailGateDone } from "../../src/lib/analytics";
import { applySkin, readSkin } from "../../src/lib/skins";
import "../../src/styles.css";

setAnalyticsEnabled(false); setEmailGateDone("skipped"); applySkin(readSkin());
const now = Math.floor(Date.now() / 1000);
const chats = [
  { id: "120363111111111111@g.us", name: "Ops Crew", preview: "stage load-in moved to 7am", group: true, lastAt: now - 600, fromMe: false },
  { id: "60123456789@c.us", name: "Aina (Client)", preview: "can send the quotation by friday?", lastAt: now - 3600, fromMe: false },
  { id: "120363222222222222@g.us", name: "Events x Venue", preview: "rider attached", group: true, lastAt: now - 7200, fromMe: true },
  { id: "219920001234567@lid", name: null, preview: "ok noted", lastAt: now - 86400, fromMe: false },
  { id: "60198765432@c.us", name: null, preview: "thanks bro", lastAt: now - 2 * 86400, fromMe: true },
  { id: "120363333333333333@g.us", name: null, preview: "", group: true, lastAt: now - 3 * 86400, fromMe: false },
  { id: "60111222333@c.us", name: "Hafiz Sound", preview: "mixer booked", lastAt: now - 5 * 86400, fromMe: false },
];
const realFetch = window.fetch.bind(window);
window.fetch = (input, init) => String(typeof input === "string" ? input : input instanceof URL ? input : input.url).includes("/api/whatsapp/permissions")
  ? Promise.resolve(new Response(JSON.stringify({ accountId: "60111111111@c.us", chats }), { headers: { "content-type": "application/json" } }))
  : realFetch(input, init);
createRoot(document.getElementById("root")!).render(<StoreProvider>
  <div className="min-h-screen bg-panel p-8"><div className="mx-auto w-[440px]"><WhatsAppPermissions /></div></div>
</StoreProvider>);
