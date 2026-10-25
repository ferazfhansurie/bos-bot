import { describe, expect, it } from "vitest";
import { claimPreset, inviteTokenFromLink, parsePresetClaim, presetTokenFromLink, withPresetBroker } from "./preset-link.mjs";

const TOKEN = "AbCdEfGhIjKlMnOpQrStUv";
const BROKER = "a".repeat(64);

describe("setup preset links", () => {
  it("reads the token from a setup link only", () => {
    expect(presetTokenFromLink(`bosbot://setup?for=${TOKEN}`)).toBe(TOKEN);
    expect(presetTokenFromLink(`bosbot://setup/?for=${TOKEN}`)).toBe(TOKEN);
    expect(presetTokenFromLink(`https://setup?for=${TOKEN}`)).toBeNull();
    expect(presetTokenFromLink(`bosbot://offer/digital-marketer`)).toBeNull();
    expect(presetTokenFromLink(`bosbot://setup?for=short`)).toBeNull();
    expect(presetTokenFromLink(`bosbot://setup?for=${TOKEN}&x=1`)).toBeNull();
    expect(presetTokenFromLink(`bosbot://setup?for=${TOKEN}&for=${TOKEN}`)).toBeNull();
    expect(presetTokenFromLink(`bosbot://setup/other?for=${TOKEN}`)).toBeNull();
  });

  it("keeps broker access only when it is https with a real token", () => {
    expect(parsePresetClaim({ preset: { id: "p" }, composio: { url: "https://bosbot.my/composio/", token: BROKER } }))
      .toEqual({ preset: { id: "p" }, composio: { url: "https://bosbot.my/composio", token: BROKER } });
    expect(parsePresetClaim({ preset: { id: "p" }, composio: { url: "http://evil.example", token: BROKER } })?.composio).toBeNull();
    expect(parsePresetClaim({ preset: { id: "p" }, composio: { url: "https://bosbot.my/composio", token: "x" } })?.composio).toBeNull();
    expect(parsePresetClaim({ composio: {} })).toBeNull();
  });

  it("never replaces a connected-apps identity the computer already has", () => {
    const fresh = {};
    expect(withPresetBroker(fresh, { url: "https://bosbot.my/composio", token: BROKER })).toBe(true);
    expect(fresh).toEqual({ composioBrokerToken: BROKER, composioBrokerUrl: "https://bosbot.my/composio" });
    const existing = { composioBrokerToken: "b".repeat(64) };
    expect(withPresetBroker(existing, { url: "https://bosbot.my/composio", token: BROKER })).toBe(false);
    expect(existing.composioBrokerToken).toBe("b".repeat(64));
  });

  it("claims with a JSON POST and surfaces the service's error", async () => {
    const calls = [];
    const ok = await claimPreset(TOKEN, { fetchImpl: async (url, init) => { calls.push([url, init]); return new Response(JSON.stringify({ preset: { id: "p" } }), { status: 200 }); } });
    expect(ok).toEqual({ preset: { id: "p" }, composio: null });
    expect(calls[0][1]).toMatchObject({ method: "POST", redirect: "error", body: JSON.stringify({ token: TOKEN }) });
    await expect(claimPreset(TOKEN, { fetchImpl: async () => new Response(JSON.stringify({ error: "This link was already used." }), { status: 410 }) }))
      .rejects.toThrow("already used");
  });
});

describe("friend invite links", () => {
  it("reads the token from an invite link only", () => {
    expect(inviteTokenFromLink(`bosbot://invite?token=${TOKEN}`)).toBe(TOKEN);
    expect(inviteTokenFromLink(`bosbot://invite/?token=${TOKEN}`)).toBe(TOKEN);
    expect(inviteTokenFromLink(`https://invite?token=${TOKEN}`)).toBeNull();
    expect(inviteTokenFromLink(`bosbot://setup?for=${TOKEN}`)).toBeNull();
    expect(inviteTokenFromLink(`bosbot://invite?token=${TOKEN}&next=x`)).toBeNull();
    expect(inviteTokenFromLink(`bosbot://invite?token=a/b`)).toBeNull();
  });
});
