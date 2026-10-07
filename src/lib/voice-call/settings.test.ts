import { describe, expect, it } from "vitest";

import { loadVoiceSettings, normalizeVoiceSettings, saveVoiceSettings } from "./settings";

const options = { voices: ["liora", "eve", "ara"], speeds: [0.5, 1, 1.5, 2], languages: ["auto", "en", "ms"] };

function memoryStore() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  };
}

describe("voice settings", () => {
  it("falls back to liora, 1x, auto", () => {
    expect(normalizeVoiceSettings(null, options)).toEqual({ voice: "liora", speed: 1, language: "auto" });
  });

  it("drops a voice or language the server no longer offers", () => {
    expect(normalizeVoiceSettings({ voice: "gone", speed: 1.4, language: "fr" }, options)).toEqual({
      voice: "liora",
      speed: 1.5,
      language: "auto",
    });
    expect(normalizeVoiceSettings({}, { ...options, voices: ["ara"] }).voice).toBe("ara");
  });

  it("round-trips per bot and survives garbage", () => {
    const store = memoryStore();
    saveVoiceSettings("bot-a", { voice: "eve", speed: 2, language: "ms" }, store);
    expect(store.map.has("bos.voiceCall.settings.bot-a")).toBe(true);
    expect(loadVoiceSettings("bot-a", options, store)).toEqual({ voice: "eve", speed: 2, language: "ms" });
    expect(loadVoiceSettings("bot-b", options, store).voice).toBe("liora");
    store.map.set("bos.voiceCall.settings.bot-c", "{nope");
    expect(loadVoiceSettings("bot-c", options, store)).toEqual({ voice: "liora", speed: 1, language: "auto" });
  });
});
