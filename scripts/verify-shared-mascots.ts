// Real shared-room API + ordinary App renderer; only disposable identities/fake provider.
// Default stays open for browser acceptance. --smoke checks the fixture and exits.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";
import { fixtureApi, mountPreview, parkUntilSignal, type MountedPreview } from "./testing/preview-fixture.ts";

const gate = join("/tmp", `shared-mascots-${randomUUID()}.gate`);
const fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: gate });
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
  for (const bot of bots) await api("PATCH", `/api/bots/${bot.id}`, bot.name === "Pepper"
    ? { color: "orange", mascotBody: "bear" } : { color: "pink", mascotBody: "cat" });
  const { room } = await api("POST", "/api/multiplayer/rooms", { name: "Mascot acceptance", memberIds: [me.actorId, teammate] });
  const route = `/api/multiplayer/rooms/${room.id}`;
  const roster = (await api("GET", `${route}/bots`)).bots;
  assert(roster.some((bot: any) => bot.name === "Pepper" && bot.color === "orange" && bot.mascotBody === "bear"));
  assert(roster.some((bot: any) => bot.name === "Willow" && bot.color === "pink" && bot.mascotBody === "cat"));
  for (const bot of bots) await api("POST", `${route}/messages`, { text: `@${bot.name} hello`, sendId: `ask-${bot.name}`, botTargets: [`${me.homeId}:bot:${bot.id}`] });
  await api("POST", `${route}/messages`, { text: "Human message while both bots work", sendId: "human-after" });
  ui = await mountPreview(fixture, { entry: "/scripts/testing/threads-preview.tsx", route: "/__shared-mascots.html", title: "Shared mascot acceptance",
    extraRoutes: [{ path: "/__finish-mascots", method: "POST", handler: (_req, res) => { writeFileSync(gate, "finish"); res.end("ok"); } }] });
  const page = await fetch(ui.previewUrl);
  assert.equal(page.status, 200);
  assert((await page.text()).includes("threads-preview.tsx"));
  console.log(JSON.stringify({ previewUrl: ui.previewUrl, roomId: room.id, fixtureUrl: fixture.info.url,
    expected: "Pepper orange bear + Willow pink cat working, same bodies on replies; human room header unchanged",
    finishUrl: new URL("/__finish-mascots", ui.previewUrl).href }));
  if (!process.argv.includes("--smoke")) await parkUntilSignal();
} finally {
  writeFileSync(gate, "finish");
  await ui?.close();
  await fixture.close();
  rmSync(gate, { force: true });
}
