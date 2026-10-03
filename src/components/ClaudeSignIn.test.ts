import { describe, expect, it } from "vitest";

import { ApiError } from "@/state/store";
import { claudeSignInLink, statusAfterComplete } from "./ClaudeSignIn";

describe("the Claude sign-in link shown in Settings", () => {
  it("is only ever Anthropic's own page over https", () => {
    expect(claudeSignInLink("https://claude.com/cai/oauth/authorize?code=true&state=x")).toBe("https://claude.com/cai/oauth/authorize?code=true&state=x");
    expect(claudeSignInLink("https://console.anthropic.com/oauth/authorize")).toBeTruthy();
    expect(claudeSignInLink("https://sub.claude.ai/x")).toBeTruthy();
    expect(claudeSignInLink("http://claude.com/x")).toBeNull();
    expect(claudeSignInLink("https://claude.com.evil.example/x")).toBeNull();
    expect(claudeSignInLink("https://evil.example/?u=https://claude.com")).toBeNull();
    expect(claudeSignInLink("https://a:b@claude.com/x")).toBeNull();
    expect(claudeSignInLink(null)).toBeNull();
    expect(claudeSignInLink("not a url")).toBeNull();
  });
});

describe("the Claude sign-in after the code was accepted", () => {
  it("shows the server's terminal status when it still has the flow", async () => {
    const status = { phase: "succeeded" as const, flowId: "f1", authorizationUrl: null, expiresAt: null };
    await expect(statusAfterComplete("f1", async () => status)).resolves.toEqual(status);
  });

  it("reads as connected, not failed, when the finished flow is already gone", async () => {
    const gone = async () => { throw new ApiError("This sign-in is no longer available in this browser. Start a new sign-in.", 404); };
    await expect(statusAfterComplete("f1", gone)).resolves.toMatchObject({ phase: "succeeded", flowId: "f1" });
  });

  it("still surfaces unrelated errors from the status check", async () => {
    const broken = async () => { throw new ApiError("server error", 500); };
    await expect(statusAfterComplete("f1", broken)).rejects.toThrow("server error");
  });
});
