import { describe, expect, it } from "vitest";
import type { RequestAuth } from "./request-auth.ts";
import { readOwnerOutputBody } from "./output-draft-access.ts";

const auth: RequestAuth = { kind: "session", via: "bearer", scopes: ["client"], session: { id: "owner-session", label: "fixture", tokenHash: "fixture", scopes: ["client"], createdAt: 0, lastSeenAt: 0, expiresAt: Number.MAX_SAFE_INTEGER } };
describe("owner draft saves across body reads", () => {
  it("fails closed for an unbound actor before reading any body", async () => {
    let read = false;
    await expect(readOwnerOutputBody(auth, { ownerId: "owner", actor: () => null, live: () => true }, async () => { read = true; return {}; })).rejects.toMatchObject({ status: 403 });
    expect(read).toBe(false);
  });
  it("refuses a session revoked while its body was arriving", async () => {
    let live = true;
    await expect(readOwnerOutputBody(auth, { ownerId: "owner", actor: () => "owner", live: () => live }, async () => { await Promise.resolve(); live = false; return {}; })).rejects.toMatchObject({ status: 401 });
  });
  it("refuses an actor rebound or unbound while the body was arriving", async () => {
    for (const rebound of ["another-person", null]) {
      let actor: string | null = "owner";
      await expect(readOwnerOutputBody(auth, { ownerId: "owner", actor: () => actor, live: () => true }, async () => { await Promise.resolve(); actor = rebound; return {}; })).rejects.toMatchObject({ status: 403 });
    }
  });
  it("allows a live owner, and denies peer credentials even when owner-bound", async () => {
    const gates = { ownerId: "owner", actor: () => "owner", live: () => true };
    await expect(readOwnerOutputBody(auth, gates, async () => ({ revision: 3 }))).resolves.toEqual({ revision: 3 });
    await expect(readOwnerOutputBody({ ...auth, scopes: ["peer"] } as RequestAuth, gates, async () => ({}))).rejects.toMatchObject({ status: 403 });
  });
});
