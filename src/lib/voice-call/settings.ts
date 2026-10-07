// Voice / speed / language are remembered per bot, like Grok Bot remembers
// them per agent. Stored in localStorage; anything unreadable falls back.

import { AUTO_LANGUAGE, DEFAULT_SPEED, DEFAULT_VOICE, snapSpeed, type VoiceCallOptions, type VoiceSettings } from "./protocol";

const KEY_PREFIX = "bos.voiceCall.settings.";

type Store = Pick<Storage, "getItem" | "setItem">;

function storage(): Store | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  voice: DEFAULT_VOICE,
  speed: DEFAULT_SPEED,
  language: AUTO_LANGUAGE,
};

/** Keep a setting only if the server still offers it. */
export function normalizeVoiceSettings(raw: unknown, options?: VoiceCallOptions | null): VoiceSettings {
  const value = raw && typeof raw === "object" ? (raw as Partial<VoiceSettings>) : {};
  const voices = options?.voices ?? [];
  const languages = options?.languages ?? [];
  const voice =
    typeof value.voice === "string" && (voices.length === 0 || voices.includes(value.voice))
      ? value.voice
      : voices.includes(DEFAULT_VOICE) || voices.length === 0
        ? DEFAULT_VOICE
        : voices[0];
  const speed = snapSpeed(typeof value.speed === "number" ? value.speed : DEFAULT_SPEED, options?.speeds ?? undefined);
  const language =
    typeof value.language === "string" && (languages.length === 0 || languages.includes(value.language))
      ? value.language
      : AUTO_LANGUAGE;
  return { voice, speed, language };
}

export function loadVoiceSettings(botId: string, options?: VoiceCallOptions | null, store: Store | null = storage()): VoiceSettings {
  let parsed: unknown = null;
  try {
    const raw = store?.getItem(KEY_PREFIX + botId);
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  return normalizeVoiceSettings(parsed, options);
}

export function saveVoiceSettings(botId: string, settings: VoiceSettings, store: Store | null = storage()): void {
  try {
    store?.setItem(KEY_PREFIX + botId, JSON.stringify(settings));
  } catch {
    // Storage full or blocked: the setting still applies to this call.
  }
}
