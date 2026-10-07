// Sign-in state for the cloud rooms screen. identity_unavailable is always
// retryable and never treated as signed out; session_invalid while signed in
// means the session was revoked elsewhere and the user must sign in again.
import type { CloudFailure, CloudSession } from "./api";

export type IdentityProblem = { kind: "session_invalid" } | { kind: "identity_unavailable"; retry_after?: number };

export type AuthState =
  | { status: "checking" }
  | { status: "signed_out" }
  | { status: "revoked" }
  | { status: "unavailable"; retry_at: number }
  /** `unavailable_until` is set while the issuer can't confirm the session; the session is kept. */
  | { status: "signed_in"; session: CloudSession; unavailable_until: number | null };

export type AuthAction =
  | { type: "checked"; session: CloudSession }
  | { type: "identity"; problem: IdentityProblem | null; now: number }
  | { type: "signed_out" };

const DEFAULT_RETRY_S = 5;

export function identityProblem(failure: CloudFailure): IdentityProblem | null {
  if (!("error" in failure)) return null;
  if (failure.error === "identity_unavailable") return { kind: "identity_unavailable", retry_after: failure.retry_after };
  if (failure.error === "session_invalid" || failure.status === 401) return { kind: "session_invalid" };
  return null;
}

export function retryDelayMs(problem: Extract<IdentityProblem, { kind: "identity_unavailable" }>): number {
  return Math.max(1, problem.retry_after ?? DEFAULT_RETRY_S) * 1000;
}

export function authReducer(state: AuthState, action: AuthAction): AuthState {
  switch (action.type) {
    case "checked":
      return { status: "signed_in", session: action.session, unavailable_until: null };
    case "signed_out":
      return { status: "signed_out" };
    case "identity": {
      const problem = action.problem;
      if (state.status === "signed_in") {
        if (!problem) return state.unavailable_until === null ? state : { ...state, unavailable_until: null };
        if (problem.kind === "session_invalid") return { status: "revoked" };
        return { ...state, unavailable_until: action.now + retryDelayMs(problem) };
      }
      if (!problem) return state;
      // Before a session is confirmed, an invalid one is just signed out.
      if (problem.kind === "session_invalid") return state.status === "revoked" ? state : { status: "signed_out" };
      return { status: "unavailable", retry_at: action.now + retryDelayMs(problem) };
    }
  }
}
