// Providers offered under Settings → Engines → Add a model. Each speaks the
// OpenAI-compatible Chat Completions API at this base URL; "custom" takes any
// other base URL (a local server, a gateway, another vendor).
import type { ProviderIconPreset } from "./provider-icon.ts";

export const API_PROVIDERS = [
  { id: "anthropic", label: "Anthropic", url: "https://api.anthropic.com/v1", icon: "anthropic", keyUrl: "https://console.anthropic.com/settings/keys" },
  { id: "openai", label: "OpenAI", url: "https://api.openai.com/v1", icon: "openai", keyUrl: "https://platform.openai.com/api-keys" },
  { id: "google", label: "Google Gemini", url: "https://generativelanguage.googleapis.com/v1beta/openai", icon: "google", keyUrl: "https://aistudio.google.com/apikey" },
  { id: "xai", label: "xAI", url: "https://api.x.ai/v1", icon: "xai", keyUrl: "https://console.x.ai" },
  { id: "openrouter", label: "OpenRouter", url: "https://openrouter.ai/api/v1", icon: "openrouter", keyUrl: "https://openrouter.ai/settings/keys" },
  { id: "deepseek", label: "DeepSeek", url: "https://api.deepseek.com/v1", icon: "deepseek", keyUrl: "https://platform.deepseek.com/api_keys" },
  { id: "mistral", label: "Mistral", url: "https://api.mistral.ai/v1", icon: "mistral", keyUrl: "https://console.mistral.ai/api-keys" },
  { id: "groq", label: "Groq", url: "https://api.groq.com/openai/v1", icon: undefined, keyUrl: "https://console.groq.com/keys" },
] as const satisfies ReadonlyArray<{ id: string; label: string; url: string; icon: ProviderIconPreset | undefined; keyUrl: string }>;

export type ApiProviderId = typeof API_PROVIDERS[number]["id"] | "custom";
export const API_PROVIDER_IDS: [ApiProviderId, ...ApiProviderId[]] = ["custom", ...API_PROVIDERS.map((entry) => entry.id)];
