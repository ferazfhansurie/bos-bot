// Email OTP sign-in against the control-plane issuer (better-auth). The dev
// server proxies /api/auth to it on the page's own origin, so the protected
// session cookie it sets is same-site with /v2 and never readable by script.
export type IssuerResult = { ok: true } | { ok: false; message: string };

const MESSAGES: Record<string, string> = {
  INVALID_OTP: "that code didn't match",
  OTP_EXPIRED: "that code expired, send a new one",
  TOO_MANY_ATTEMPTS: "too many wrong codes, send a new one",
  INVALID_EMAIL: "that email doesn't look right",
};

async function post(path: string, body: unknown): Promise<IssuerResult> {
  try {
    const response = await fetch(`/api/auth${path}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (response.ok) return { ok: true };
    if (response.status === 429) return { ok: false, message: "too many tries, wait a minute" };
    if (response.status >= 500) return { ok: false, message: "sign-in is unavailable right now" };
    const parsed = (await response.json().catch(() => null)) as { code?: unknown } | null;
    const code = typeof parsed?.code === "string" ? parsed.code : "";
    return { ok: false, message: MESSAGES[code] ?? "couldn't sign in" };
  } catch {
    return { ok: false, message: "sign-in is unavailable right now" };
  }
}

export const issuer = {
  sendCode: (email: string) => post("/email-otp/send-verification-otp", { email, type: "sign-in" }),
  verifyCode: (email: string, otp: string) => post("/sign-in/email-otp", { email, otp }),
  signOut: () => post("/sign-out", {}),
};
