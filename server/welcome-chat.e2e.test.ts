import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";

it("says hi through the stub for the owner only", async () => {
  const fixture = await launchVerificationServer({ ...process.env, BOS_WELCOME_STUB: "1" });
  const api = async (path: string, body?: unknown, token?: string) => {
    const response = await fetch(fixture.info.url + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", origin: fixture.info.url, ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15000),
    });
    return { status: response.status, body: await response.json() as any };
  };
  try {
    const hello = await api("/api/onboarding/welcome", { name: " Putri " });
    expect(hello.status).toBe(201);
    expect(hello.body.url).toMatch(/^https:\/\/hi\.aihlete\.com\/pair#code=stub-[0-9a-f]{8}$/);
    expect(Date.parse(hello.body.expiresAt)).toBeGreaterThan(Date.now());
    // the same install id every time, so bos-server can hold one room per install
    expect((await api("/api/onboarding/welcome", { name: "Putri" })).body.url).toBe(hello.body.url);
    expect((await api("/api/onboarding/welcome", { name: "" })).status).toBe(400);
    const pairing = (await api("/api/auth/pairing", { scopes: ["client"] })).body;
    const client = (await api("/api/auth/pair", { code: pairing.code, label: "welcome fixture" })).body;
    expect((await api("/api/onboarding/welcome", { name: "Putri" }, client.token)).status).toBe(403);
  } finally { await fixture.close(); }
}, 40000);
