// The voice-call mint, driven against a stub fetch: what we send xAI, that
// the key never comes back to the client, and how a refusal is reported.
import { describe, expect, it } from "vitest";

import type { AppConfig } from "./config.ts";
import { mintVoiceCallCredential, NoVoiceCallKey, VOICE_CALL_SOCKET, voiceCallPlan } from "./voice-call.ts";

const cfg = (key?: string) => ({ xai: key === undefined ? {} : { key } }) as unknown as AppConfig;

function stub(status: number, body: unknown) {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { seen, fetchImpl };
}

describe("mintVoiceCallCredential", () => {
  it("mints a short-lived secret with the key and hands back only the secret", async () => {
    const { seen, fetchImpl } = stub(200, { value: "eph-123", expires_at: 1791392807 });
    const credential = await mintVoiceCallCredential(cfg("xai-real-key"), fetchImpl, "https://stub");
    expect(seen[0].url).toBe("https://stub/v1/realtime/client_secrets");
    expect((seen[0].init.headers as Record<string, string>).authorization).toBe("Bearer xai-real-key");
    expect(JSON.parse(String(seen[0].init.body))).toEqual({ expires_after: { seconds: 300 } });
    expect(credential).toEqual({ clientSecret: "eph-123", expiresAt: 1791392807, model: "grok-voice-3.0", websocketUrl: VOICE_CALL_SOCKET });
    expect(JSON.stringify(credential)).not.toContain("xai-real-key");
  });

  it("accepts the nested client_secret shape too", async () => {
    const { fetchImpl } = stub(200, { client_secret: { value: "eph-9", expires_at: 5 } });
    expect((await mintVoiceCallCredential(cfg("k"), fetchImpl, "https://stub")).clientSecret).toBe("eph-9");
  });

  it("says the key is missing before calling xAI", async () => {
    const { seen, fetchImpl } = stub(200, {});
    await expect(mintVoiceCallCredential(cfg(), fetchImpl, "https://stub")).rejects.toBeInstanceOf(NoVoiceCallKey);
    await expect(mintVoiceCallCredential(cfg("  "), fetchImpl, "https://stub")).rejects.toBeInstanceOf(NoVoiceCallKey);
    expect(seen).toHaveLength(0);
  });

  it("reports xAI's refusal with its status", async () => {
    const { fetchImpl } = stub(401, { error: "Incorrect API key" });
    await expect(mintVoiceCallCredential(cfg("bad"), fetchImpl, "https://stub")).rejects.toThrow(/401.*Incorrect API key/);
  });

  it("rejects a 200 without a secret", async () => {
    const { fetchImpl } = stub(200, { expires_at: 1 });
    await expect(mintVoiceCallCredential(cfg("k"), fetchImpl, "https://stub")).rejects.toThrow(/no voice call secret/);
  });
});

describe("voiceCallPlan", () => {
  it("names the bot and caller, and carries the four call tools", () => {
    const plan = voiceCallPlan({ agentName: "bos (lead)", userName: "Firaz Fhansurie", language: "ms" });
    expect(plan.instructions).toContain("You are bos, on a live phone call with the person you work for, Firaz.");
    expect(plan.instructions).toContain("Speak and listen in ms.");
    expect(plan.instructions).not.toMatch(/\n\n\n/);
    expect(plan.tools.map(t => t.name)).toEqual(["send_task", "recall_text_messages", "stay_silent", "end_the_call"]);
    expect(plan.greeting.direction).toContain("to Firaz");
  });

  it("asks for a first-person request, one send per job, and answers status from landed work", () => {
    const plan = voiceCallPlan({ agentName: "bos", userName: "Firaz Fhansurie" });
    const sendTask = plan.tools.find(t => t.name === "send_task")!;
    const request = sendTask.parameters.properties.request.description;
    expect(request).toContain("restated cleanly in first person");
    expect(request).toContain("Never third person");
    expect(request).not.toContain("Not the caller's sentence");
    expect(sendTask.description).toContain("never send it again");
    expect(sendTask.description).toContain("answer from the work_landed entries on this call");
    expect(plan.instructions).toContain("Each job goes out once.");
    expect(plan.instructions).toContain("If nothing has landed for it, say it is still running. Never send_task to check.");
    expect(plan.instructions).toContain("first person");
  });

  it("leaves the language to the caller on auto", () => {
    expect(voiceCallPlan({ agentName: "x", language: "auto" }).instructions).toContain("Answer in the language they speak to you.");
  });
});
