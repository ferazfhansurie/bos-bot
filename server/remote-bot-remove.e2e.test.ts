import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";

// Two real homes: deleting B's shared bot on A takes it off A's list only.
const LINK_ORIGIN = "https://delegated-fixture.example.ts.net:8443";

type Fixture = Awaited<ReturnType<typeof launchVerificationServer>>;

test("deleting a linked bot removes it from this home only, and add back lists it again", async () => {
  const b = await launchVerificationServer({ FAKE_CLAUDE_TOOL_CALLS: "[]" });
  let a: Fixture | undefined;
  const api = async (fixture: Fixture, method: string, path: string, body?: unknown, expected?: number) => {
    const response = await fetch(fixture.info.url + path, { method, headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) });
    const result = await response.json() as any;
    if (expected !== undefined) expect(response.status, `${method} ${path}: ${JSON.stringify(result)}`).toBe(expected);
    return { status: response.status, body: result };
  };
  try {
    const bHome = (await api(b, "GET", "/.well-known/openmausbot/environment")).body.environmentId as string;
    const template = (await api(b, "GET", "/api/bots")).body.bots[0];
    const pixie = (await api(b, "POST", "/api/bots", { name: "Pixie", title: "Fixture", modelSelection: template.modelSelection }, 201)).body.bot;
    const pairing = await api(b, "POST", "/api/auth/pairing", { scopes: ["peer"] }, 200);
    const paired = await api(b, "POST", "/api/auth/pair", { code: pairing.body.code, label: "BOS peer bridge" }, 200);
    a = await launchVerificationServer({}, undefined, undefined, undefined, undefined, undefined, [], undefined, {
      origin: b.info.url, prepare: dataDir => {
        writeFileSync(join(dataDir, "environment-id"), randomUUID());
        writeFileSync(join(dataDir, "multiplayer-links.json"), JSON.stringify({ version: 1, links: [{
          homeId: bHome, name: "B", origin: LINK_ORIGIN, token: paired.body.token, bots: [], proxyGroups: {},
        }] }));
      },
    });
    const A = a;
    const listedOnA = async () => (await api(A, "GET", "/api/bots")).body.bots.find((bot: any) => bot.id.startsWith("rb-") && bot.id.endsWith(`-${pixie.id}`))?.id ?? "";
    let rbId = "";
    await expect.poll(async () => (rbId = await listedOnA()), { timeout: 30_000, interval: 250 }).not.toBe("");

    await api(A, "DELETE", `/api/bots/${rbId}`, undefined, 200);
    expect(await listedOnA()).toBe("");
    // still on B, and the link to B is still there
    expect((await api(b, "GET", "/api/bots")).body.bots.some((bot: any) => bot.id === pixie.id)).toBe(true);
    const links = (await api(A, "GET", "/api/multiplayer/links", undefined, 200)).body;
    expect(links.removedBots).toEqual([expect.objectContaining({ homeId: bHome, remoteBotId: pixie.id, name: "Pixie" })]);
    await api(A, "DELETE", `/api/bots/${rbId}`, undefined, 404);

    await api(A, "POST", `/api/multiplayer/links/${bHome}/bots/${pixie.id}/add-back`, {}, 200);
    await expect.poll(listedOnA, { timeout: 10_000, interval: 250 }).toBe(rbId);
    expect((await api(A, "GET", "/api/multiplayer/links", undefined, 200)).body.removedBots).toEqual([]);
  } finally {
    await Promise.all([a?.close(), b.close()]);
  }
}, 120_000);
