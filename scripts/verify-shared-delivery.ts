import { launchVerificationServer } from "./control-omb.ts";
import { fixtureApi, mountPreview, parkUntilSignal, type MountedPreview } from "./testing/preview-fixture.ts";
const fixture = await launchVerificationServer();
let ui: MountedPreview | undefined;
try {
  const api = fixtureApi(fixture.info.url);
  await api("PUT", "/api/config", { profile: { name: "Alex" } });
  const me = await api("GET", "/api/multiplayer/me");
  const pairing = await api("POST", "/api/auth/pairing", { scopes: ["peer"] });
  const paired = await api("POST", "/api/auth/pair", { code: pairing.code, label: "Fixture teammate" });
  const teammate = "delivery-fixture:person:owner";
  await api("POST", "/api/multiplayer/actor-bindings", { sessionId: paired.session.id, personId: teammate, name: "Maya" });
  const { room } = await api("POST", "/api/multiplayer/rooms", { name: "Delivery checks", memberIds: [me.actorId, teammate] });
  const path = `/api/multiplayer/rooms/${room.id}`;
  let loseAcknowledgement = true, uploads = 0;
  const sends: unknown[] = [];
  const forward = async (req: import("node:http").IncomingMessage, route: string) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    const response = await fetch(fixture.info.url + route, { method: "POST", headers: { "content-type": "application/json", origin: fixture.info.url }, body });
    return { body: JSON.parse(body), status: response.status, result: await response.json() };
  };
  ui = await mountPreview(fixture, { entry: "/scripts/testing/shared-delivery-preview.tsx", route: "/__shared-delivery.html", title: "BOS isolated delivery checks", extraRoutes: [
    { path: path + "/attachments", method: "POST", handler: async (req, res) => {
      uploads++; const response = await forward(req, path + "/attachments");
      res.writeHead(response.status, { "content-type": "application/json" }); res.end(JSON.stringify(response.result));
    } },
    { path: path + "/messages", method: "POST", handler: async (req, res) => {
      const response = await forward(req, path + "/messages"); sends.push(response.body);
      if (loseAcknowledgement && response.status < 300) {
        loseAcknowledgement = false;
        await new Promise(resolve => setTimeout(resolve, 3000));
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Fixture lost the acknowledgement after accepting the send. Retry safely." })); return;
      }
      res.writeHead(response.status, { "content-type": "application/json" }); res.end(JSON.stringify(response.result));
    } },
    { path: "/__delivery-evidence", method: "GET", handler: async (_req, res) => {
      const page = await api("GET", path + "/messages");
      res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ uploads, sends, messages: page.messages }));
    } },
  ] });
  console.log(JSON.stringify({ ...fixture.info, previewUrl: ui.previewUrl + "?room=" + room.id, roomId: room.id }));
  await parkUntilSignal();
} finally { await ui?.close(); await fixture.close(); }
