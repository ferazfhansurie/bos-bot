import { describe, expect, it } from "vitest";
import type { CloudSession } from "./api";
import { authReducer, identityProblem, type AuthState } from "./auth-state";

const session: CloudSession = { baseUrl: "http://127.0.0.1:1", bearer: null, account_id: "a1", issuer: "http://127.0.0.1:8787", subject: "u1", service: "bos" };
const signedIn: AuthState = { status: "signed_in", session, unavailable_until: null };

describe("cloud sign-in state", () => {
  it("classifies identity failures and leaves everything else alone", () => {
    expect(identityProblem({ error: "identity_unavailable", status: 503, retry_after: 2 })).toEqual({ kind: "identity_unavailable", retry_after: 2 });
    expect(identityProblem({ error: "session_invalid", status: 401 })).toEqual({ kind: "session_invalid" });
    expect(identityProblem({ error: "unauthenticated", status: 401 })).toEqual({ kind: "session_invalid" });
    expect(identityProblem({ error: "forbidden", status: 403 })).toBeNull();
    expect(identityProblem({ transport: true, status: 502 })).toBeNull();
  });

  it("never signs out on identity_unavailable and clears it on the next success", () => {
    const degraded = authReducer(signedIn, { type: "identity", problem: { kind: "identity_unavailable", retry_after: 3 }, now: 1000 });
    expect(degraded).toEqual({ status: "signed_in", session, unavailable_until: 4000 });
    expect(authReducer(degraded, { type: "identity", problem: null, now: 2000 })).toEqual(signedIn);
    expect(authReducer(signedIn, { type: "identity", problem: null, now: 2000 })).toBe(signedIn);
  });

  it("shows revoked when a signed-in session turns invalid, plain signed out before that", () => {
    expect(authReducer(signedIn, { type: "identity", problem: { kind: "session_invalid" }, now: 0 })).toEqual({ status: "revoked" });
    expect(authReducer({ status: "checking" }, { type: "identity", problem: { kind: "session_invalid" }, now: 0 })).toEqual({ status: "signed_out" });
    expect(authReducer({ status: "revoked" }, { type: "identity", problem: { kind: "session_invalid" }, now: 0 })).toEqual({ status: "revoked" });
  });

  it("waits out an unavailable issuer at boot instead of asking to sign in", () => {
    const state = authReducer({ status: "checking" }, { type: "identity", problem: { kind: "identity_unavailable" }, now: 1000 });
    expect(state).toEqual({ status: "unavailable", retry_at: 6000 });
    expect(authReducer(state, { type: "checked", session })).toEqual(signedIn);
    expect(authReducer(signedIn, { type: "signed_out" })).toEqual({ status: "signed_out" });
  });
});
