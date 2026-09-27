// Published file index and source navigation against a disposable workspace.
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
  const teammate = "fixture-teammate:person:owner";
  await api("POST", "/api/multiplayer/actor-bindings", { sessionId: paired.session.id, personId: teammate, name: "Maya" });
  const { room } = await api("POST", "/api/multiplayer/rooms", { name: "Launch crew", memberIds: [me.actorId, teammate] });
  const path = `/api/multiplayer/rooms/${room.id}`;
  const { attachment } = await api("POST", `${path}/attachments`, { name: "launch-brief.txt", mime: "text/plain", data: Buffer.from("The original launch brief.\nOwners: Alex and Maya.").toString("base64") });
  const { message } = await api("POST", `${path}/messages`, { text: "The original launch brief is attached here.", sendId: "original-brief", attachments: [attachment] });
  for (let n = 0; n < 205; n++) await api("POST", `${path}/messages`, { text: `Launch discussion ${n + 1}`, sendId: `discussion-${n}` });
  const { attachment: recent } = await api("POST", `${path}/attachments`, { name: "review-notes.txt", mime: "text/plain", data: Buffer.from("Check group mentions on both devices.").toString("base64") });
  await api("POST", `${path}/messages`, { text: "Review notes for today", sendId: "recent-notes", attachments: [recent] });
  const index = await api("GET", `${path}/files`);
  if (index.files.length !== 2 || index.files[1].messageId !== message.id) throw new Error("File index lost an older source");
  ui = await mountPreview(fixture, { entry: "/scripts/testing/threads-preview.tsx", route: "/__shared-files.html", title: "BOS shared files acceptance" });
  console.log(JSON.stringify({ ...fixture.info, previewUrl: ui.previewUrl, roomId: room.id, sourceId: message.id, files: index.files.length }));
  await parkUntilSignal();
} finally { await ui?.close(); await fixture.close(); }
