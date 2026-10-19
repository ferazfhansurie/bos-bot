import type { RequestAuth } from "./request-auth.ts";

export interface OwnerGates { ownerId: string; actor: (auth: RequestAuth) => string | null; live: (sessionId: string) => boolean }

/** Owner on a live, non-peer session, or throw 401/403. */
export function assertOwnerAccess(auth: RequestAuth, gates: OwnerGates): void {
  if (auth.kind === "session" && !gates.live(auth.session.id)) throw Object.assign(new Error("session revoked"), { status: 401 });
  if ((auth.kind === "session" && auth.scopes.includes("peer")) || gates.actor(auth) !== gates.ownerId) throw Object.assign(new Error("owner access required"), { status: 403 });
}

/** Body reads yield: never carry owner authority across that await unchecked. */
export async function readOwnerOutputBody<T>(
  auth: RequestAuth,
  gates: OwnerGates,
  read: () => Promise<T>,
): Promise<T> {
  assertOwnerAccess(auth, gates);
  const body = await read();
  assertOwnerAccess(auth, gates);
  return body;
}
