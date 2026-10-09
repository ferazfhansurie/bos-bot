import { describe, expect, it, vi } from "vitest";
import { helloName, sayHi } from "./welcome-chat";

const failing = (status: number) => vi.fn(async () => { throw Object.assign(new Error("no"), { status }); });

describe("sayHi", () => {
  it("opens the link the server returns", async () => {
    const request = vi.fn(async () => ({ url: "https://hi.aihlete.com/pair#code=abc", expiresAt: "x" }));
    expect(await sayHi("  Putri ", request)).toEqual({ kind: "open", url: "https://hi.aihlete.com/pair#code=abc" });
    expect(request).toHaveBeenCalledWith("/api/onboarding/welcome", expect.objectContaining({ method: "POST", body: JSON.stringify({ name: "Putri" }) }));
  });

  it("asks to try later on 429", async () => {
    expect(await sayHi("Putri", failing(429))).toMatchObject({ kind: "later" });
  });

  it("hides on 503, other errors or a missing link", async () => {
    expect(await sayHi("Putri", failing(503))).toEqual({ kind: "hide" });
    expect(await sayHi("Putri", failing(500))).toEqual({ kind: "hide" });
    expect(await sayHi("Putri", vi.fn(async () => ({})))).toEqual({ kind: "hide" });
  });
});

describe("helloName", () => {
  it("starts from the profile name, trimmed to 40", () => {
    expect(helloName(" Firaz  Fhansurie ")).toBe("Firaz Fhansurie");
    expect(helloName(undefined)).toBe("");
    expect(helloName("x".repeat(60))).toHaveLength(40);
  });
});
