import { afterEach, describe, expect, it, vi } from "vitest";
import { cloudApi } from "./api";
import { issuer } from "./issuer";

const respond = (status: number, body: unknown) => vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));

afterEach(() => vi.unstubAllGlobals());

describe("cloud issuer and identity transport", () => {
  it("sends the code request and verification to same-origin better-auth with the cookie", async () => {
    const fetch = respond(200, { status: true });
    vi.stubGlobal("fetch", fetch);
    expect(await issuer.sendCode("alice@example.test")).toEqual({ ok: true });
    expect(await issuer.verifyCode("alice@example.test", "12345678")).toEqual({ ok: true });
    expect(fetch.mock.calls.map(([url, init]) => [url, init?.credentials, JSON.parse(init?.body as string)])).toEqual([
      ["/api/auth/email-otp/send-verification-otp", "same-origin", { email: "alice@example.test", type: "sign-in" }],
      ["/api/auth/sign-in/email-otp", "same-origin", { email: "alice@example.test", otp: "12345678" }],
    ]);
  });

  it("explains bad codes, rate limits and an unreachable issuer", async () => {
    vi.stubGlobal("fetch", respond(400, { code: "INVALID_OTP", message: "Invalid OTP" }));
    expect(await issuer.verifyCode("a@example.test", "1")).toEqual({ ok: false, message: "that code didn't match" });
    vi.stubGlobal("fetch", respond(429, {}));
    expect(await issuer.sendCode("a@example.test")).toEqual({ ok: false, message: "too many tries, wait a minute" });
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("offline"))));
    expect(await issuer.signOut()).toEqual({ ok: false, message: "sign-in is unavailable right now" });
  });

  it("sends no authorization header for a cookie session and reports identity failures and recoveries", async () => {
    const fetch = respond(503, { error: "identity_unavailable", retry_after: 2 });
    vi.stubGlobal("fetch", fetch);
    const onIdentity = vi.fn();
    const api = cloudApi({ baseUrl: "http://127.0.0.1:5199", bearer: null, account_id: "a", issuer: "i", subject: "s", service: "bos" }, onIdentity);
    await api.sync();
    expect(fetch.mock.calls[0]![1]?.headers).not.toHaveProperty("authorization");
    expect(onIdentity).toHaveBeenLastCalledWith({ kind: "identity_unavailable", retry_after: 2 });
    vi.stubGlobal("fetch", respond(403, { error: "forbidden" }));
    await api.sync();
    expect(onIdentity).toHaveBeenCalledTimes(1);
    vi.stubGlobal("fetch", respond(200, { workspaces: [] }));
    await api.sync();
    expect(onIdentity).toHaveBeenLastCalledWith(null);
    vi.stubGlobal("fetch", respond(401, { error: "session_invalid" }));
    await api.sync();
    expect(onIdentity).toHaveBeenLastCalledWith({ kind: "session_invalid" });
  });
});
