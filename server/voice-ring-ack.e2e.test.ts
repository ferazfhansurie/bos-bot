import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";

it("only the owner's paired phone can ack a ring, and a stale ring id acks nothing", async () => {
  const session = await launchVerificationServer(process.env);
  const api = async (path: string, body?: unknown, token?: string) => {
    const response = await fetch(`${session.info.url}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() as any };
  };
  try {
    // the desktop has no push session to stand for
    expect((await api("/api/voice/ring/ring-1/ack", {})).status).toBe(403);
    const pairing = await api("/api/auth/pairing", { scopes: ["admin", "client"] });
    const paired = await api("/api/auth/pair", { code: pairing.body.code, label: "fixture phone" });
    const ack = await api("/api/voice/ring/ring-1/ack", {}, paired.body.token);
    expect(ack).toEqual({ status: 200, body: { acked: false } });
    expect((await api("/api/voice/ring/../ack", {}, paired.body.token)).status).not.toBe(200);
  } finally { await session.close(); }
}, 45_000);
