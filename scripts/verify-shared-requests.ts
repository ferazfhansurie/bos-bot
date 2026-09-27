// Real human conversation routes and renderer; disposable identities/fake provider.
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";
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
  for (const name of ["Pepper", "Willow"]) await runControlOmb(["new-bot", "--name", name, "--url", fixture.info.url]);
  const { bots } = await api("GET", "/api/bots?messages=0");
  const { room } = await api("POST", "/api/multiplayer/rooms", { name: "Launch crew", memberIds: [me.actorId, teammate] });
  const route = `/api/multiplayer/rooms/${room.id}/messages`;
  await api("POST", route, { text: "Original café + plan: https://example.com/launch", sendId: "human-intro" });
  for (let index = 0; index < 205; index += 1) await api("POST", route, { text: `Team update ${index + 1}`, sendId: `team-update-${index}` });
  for (const name of ["Pepper", "Willow"]) {
    const bot = bots.find((candidate: { name: string }) => candidate.name === name);
    await api("POST", route, { text: `@${name} ${name === "Pepper" ? "summarize the launch checklist" : "review the onboarding copy"}`,
      sendId: `ask-${name.toLowerCase()}`, botTargets: [`${me.homeId}:bot:${bot.id}`] });
  }
  const deadline = Date.now() + 20_000;
  let replies = 0;
  while (Date.now() < deadline) {
    const page = await api("GET", `${route}?latest=1&limit=200`);
    replies = page.messages.filter((message: { actor: { kind: string }; kind?: string; responseTo?: string }) => message.actor.kind === "bot" && message.kind !== "activity" && message.responseTo).length;
    if (replies === 2) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (replies !== 2) throw new Error(`Expected two request-linked replies; received ${replies}`);
  ui = await mountPreview(fixture, { entry: "/scripts/testing/threads-preview.tsx", route: "/__shared-requests.html", title: "BOS shared request acceptance" });
  console.log(JSON.stringify({ ...fixture.info, previewUrl: ui.previewUrl, roomId: room.id, replies }));
  await parkUntilSignal();
} finally {
  await ui?.close();
  await fixture.close();
}
