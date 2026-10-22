import { describe, expect, it } from "vitest";
import { PRESET_SOUL_END, PRESET_SOUL_START, parsePreset, presetEngineDriver, presetResumeKey, soulWithPreset } from "./onboarding-preset.ts";

const preset = {
  id: "p_abc123",
  personName: "Mei",
  soul: "You help Mei grow her Instagram.",
  memory: [{ path: "memory/business.md", text: "# business\nonline mandarin classes" }],
  skills: [{ name: "daily-content-ideas", md: "---\nname: daily-content-ideas\ndescription: ideas\n---\n# ideas\n" }],
  prepared: { profile: [{ label: "Business", value: "Online Mandarin classes" }], team: [], firstJob: { title: "Plan my posts", prompt: "Plan three posts." } },
  connect: [{ slug: "instagram", text: "Now connect your Instagram." }],
};

describe("setup presets", () => {
  it("accepts a complete preset", () => {
    expect(parsePreset(preset)).toMatchObject({ ok: true });
  });

  it("refuses stray fields, odd memory paths and bad app slugs", () => {
    expect(parsePreset({ ...preset, token: "x" }).ok).toBe(false);
    expect(parsePreset({ ...preset, memory: [{ path: "../soul.md", text: "x" }] }).ok).toBe(false);
    expect(parsePreset({ ...preset, connect: [{ slug: "Insta gram", text: "x" }] }).ok).toBe(false);
  });

  it("adds the soul block on top once and replaces it on a second apply", () => {
    const first = soulWithPreset("I am bos.", "Help Mei.");
    expect(first).toBe(`${PRESET_SOUL_START}\nHelp Mei.\n${PRESET_SOUL_END}\n\nI am bos.`);
    expect(soulWithPreset(first, "Help Mei.")).toBe(first);
    const second = soulWithPreset(first, "Help Mei more.");
    expect(second).toContain("Help Mei more.");
    expect(second.match(/bos preset: set up/g)).toHaveLength(1);
    expect(second.endsWith("I am bos.")).toBe(true);
  });

  it("names the engine the person already has, and only the ones BOS runs", () => {
    expect(parsePreset({ ...preset, engine: "codex" })).toMatchObject({ ok: true, preset: { engine: "codex" } });
    expect(parsePreset({ ...preset, engine: "gemini" }).ok).toBe(false);
    expect(presetEngineDriver("codex")).toBe("codex");
    expect(presetEngineDriver("claude")).toBe("claudeAgent");
  });

  it("keys connector cards by app, long enough for the connector contract", () => {
    expect(presetResumeKey("instagram")).toMatch(/^[\w-]{8,100}$/);
  });
});
