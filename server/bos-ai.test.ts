import { afterEach, expect, it, vi } from "vitest";
import { bosAiCredit, pollBosAiClaim, startBosAi } from "./bos-ai.ts";
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const id = "6f1c2a4e-1b2c-4d3e-8f90-123456789abc";
const token = "bosf_" + "a".repeat(40);
afterEach(() => vi.unstubAllGlobals());

it("sends only the install id, never cookies, and accepts a relay token", async () => {
  const f = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => json({ token, left: 1, cap: 1, model: "gpt-6-luna" }));
  expect(await startBosAi(id, { fetch: f })).toEqual({ kind: "token", token, left: 1, cap: 1, model: "gpt-6-luna" });
  expect(f.mock.calls[0]![0]).toBe("https://bosbot.my/api/desktop-trial");
  expect(f.mock.calls[0]![1]).toMatchObject({ method: "POST", credentials: "omit", redirect: "error" });
  expect(JSON.parse(String(f.mock.calls[0]![1]!.body))).toEqual({ install: id });
  await startBosAi(id, { fetch: f, link: true });
  expect(JSON.parse(String(f.mock.calls[1]![1]!.body))).toEqual({ install: id, link: true });
});

it("takes a claim link only on bosbot.my with a matching code", async () => {
  const claim = (url: string, code = "abcdefghijklmnopqrstuvwx") => startBosAi(id, { fetch: vi.fn().mockResolvedValue(json({ claim: url, code })) });
  expect(await claim("https://bosbot.my/desktop/claim?c=abcdefghijklmnopqrstuvwx")).toMatchObject({ kind: "claim", code: "abcdefghijklmnopqrstuvwx" });
  for (const bad of ["https://evil.example/desktop/claim?c=abcdefghijklmnopqrstuvwx", "http://bosbot.my/desktop/claim?c=abcdefghijklmnopqrstuvwx", "https://bosbot.my/desktop/claim?c=other"])
    await expect(claim(bad)).rejects.toThrow("invalid response");
  await expect(startBosAi(id, { fetch: vi.fn().mockResolvedValue(json({ token: "sk-or-leak" })) })).rejects.toThrow("invalid response");
  await expect(startBosAi(id, { fetch: vi.fn().mockResolvedValue(json({}, 429)) })).rejects.toThrow("Too many tries");
  await expect(startBosAi(id, { fetch: vi.fn().mockRejectedValue(new Error("offline")) })).rejects.toThrow("Could not reach bosbot.my");
});

it("polls a claim to pending, token or expired", async () => {
  const code = "abcdefghijklmnopqrstuvwx";
  expect(await pollBosAiClaim(code, { fetch: vi.fn().mockResolvedValue(json({ pending: true })) })).toEqual({ state: "pending" });
  expect(await pollBosAiClaim(code, { fetch: vi.fn().mockResolvedValue(json({ token })) })).toMatchObject({ state: "token", token });
  expect(await pollBosAiClaim(code, { fetch: vi.fn().mockResolvedValue(json({ error: "expired" }, 404)) })).toEqual({ state: "expired" });
  const f = vi.fn();
  expect(await pollBosAiClaim("../x", { fetch: f })).toEqual({ state: "expired" });
  expect(f).not.toHaveBeenCalled();
});

it("reads credit, and calls a refused token invalid", async () => {
  expect(await bosAiCredit("https://relay.invalid/api/v1/trial", token, { fetch: vi.fn().mockResolvedValue(json({ left: 0.4, cap: 1, monthFull: false })) })).toEqual({ left: 0.4, cap: 1, monthFull: false });
  expect(await bosAiCredit("https://relay.invalid/api/v1/trial", token, { fetch: vi.fn().mockResolvedValue(json({}, 403)) })).toBe("invalid");
  expect(await bosAiCredit("https://relay.invalid/api/v1/trial", token, { fetch: vi.fn().mockResolvedValue(json({}, 502)) })).toBeNull();
  expect(await bosAiCredit("https://relay.invalid/api/v1/trial", "sk-or-owner")).toBe("invalid");
});
