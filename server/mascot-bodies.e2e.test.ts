import { expect, it } from "vitest";
import { FLAT_MASCOT_BODIES } from "../shared/flat-mascot-bodies.ts";
import { launchVerificationServer } from "../scripts/control-omb.ts";

it("saves every selectable mascot through the actual profile API in an isolated home", async () => {
  const fixture = await launchVerificationServer();
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method, headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000),
    });
    return { status: response.status, body: await response.json() as any };
  };
  try {
    const created = await api("POST", "/api/bots", {
      name: "Mascot fixture", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" }, requireAvailableModel: true,
    });
    expect(created.status).toBe(201);
    const id = created.body.bot.id;
    for (const body of FLAT_MASCOT_BODIES) {
      const saved = await api("PATCH", `/api/bots/${id}/profile`, { mascotBody: body.id });
      expect(saved.status, body.id).toBe(200);
      expect(saved.body.bot.mascotBody).toBe(body.id);
    }
    const roster = await api("GET", "/api/bots");
    expect(roster.body.bots.find((bot: any) => bot.id === id).mascotBody).toBe("crown");
    expect((await api("PATCH", `/api/bots/${id}/profile`, { mascotBody: "not-a-body" })).status).toBe(400);
    expect((await api("PATCH", `/api/bots/${id}/profile`, { mascotBody: "cat", approvalMode: "full" })).status).toBe(400);
  } finally { await fixture.close(); }
}, 45_000);
