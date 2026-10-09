// The mascot colour picker on both clients, end to end against an isolated
// server. The phone writes through the paired-safe /profile route (which
// used to refuse `color` outright: "unsupported profile field: color");
// the desktop writes through the broad PATCH /api/bots/:id. Both must
// persist a palette name and a custom hex, and refuse anything else.
import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";

it("persists bot colours through the paired profile route and the desktop PATCH", async () => {
  const fixture = await launchVerificationServer();
  const api = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(fixture.info.url + path, {
      method,
      headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10000),
    });
    return { status: r.status, body: (await r.json()) as any };
  };
  const stored = async (id: string) => (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === id).color;
  try {
    const made = await api("POST", "/api/bots", {
      name: "Colour fixture",
      modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
      requireAvailableModel: true,
    });
    expect(made.status).toBe(201);
    const id = made.body.bot.id;

    // phone: paired profile route
    for (const [color, expected] of [["purple", "purple"], ["#1a2b3c", "#1A2B3C"]] as const) {
      const saved = await api("PATCH", `/api/bots/${id}/profile`, { color });
      expect(saved.status, `${color}: ${JSON.stringify(saved.body)}`).toBe(200);
      expect(saved.body.bot.color).toBe(expected);
      expect(await stored(id)).toBe(expected);
    }
    const refused = await api("PATCH", `/api/bots/${id}/profile`, { color: "chartreuse" });
    expect(refused).toEqual({ status: 400, body: { error: "color must be a palette name or #RRGGBB" } });
    // the allowlist still holds for privileged fields riding along
    expect((await api("PATCH", `/api/bots/${id}/profile`, { color: "red", approvalMode: "full" })).status).toBe(400);
    expect(await stored(id)).toBe("#1A2B3C");

    // desktop: broad PATCH
    for (const [color, expected] of [["teal", "teal"], ["#abcdef", "#ABCDEF"]] as const) {
      const saved = await api("PATCH", `/api/bots/${id}`, { color });
      expect(saved.status, `${color}: ${JSON.stringify(saved.body)}`).toBe(200);
      expect(saved.body.bot.color).toBe(expected);
      expect(await stored(id)).toBe(expected);
    }
    expect((await api("PATCH", `/api/bots/${id}`, { color: "#12" })).status).toBe(400);
    expect(await stored(id)).toBe("#ABCDEF");
  } finally {
    await fixture.close();
  }
}, 45000);
