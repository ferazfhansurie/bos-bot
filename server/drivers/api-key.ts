// Settings → Engines → "Add a model": one API key from any provider that
// speaks OpenAI chat completions (Anthropic, OpenAI, Gemini, xAI, OpenRouter,
// DeepSeek, Mistral, Groq, a local server). Unlike the retired openai-compat
// driver it inherits nothing — no workspace key, URL or env — so each
// connection is exactly what was added, and every model on that key shows in
// the picker.
import type { ModelCatalog, ProviderDriver } from "../contracts.ts";
import { fetchSetupModels, normalizeApiUrl } from "../cli-api-setup.ts";
import { createOpenAIChatRuntime } from "./openai-chat.ts";

export const API_KEY_DRIVER = "api-key";

export interface ApiKeyConfig {
  url: string;
  key: string;
  model: string;
  tools?: boolean;
}

function decodeConfig(raw: unknown): ApiKeyConfig {
  const config = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  if (!config) throw new Error("API connection config must be an object");
  if (Object.keys(config).some((key) => !["url", "key", "model", "tools"].includes(key))) {
    throw new Error("API connection config accepts only url, key, model and tools");
  }
  if (config.tools !== undefined && typeof config.tools !== "boolean") throw new Error("tools must be a boolean");
  if (typeof config.url !== "string" || !config.url) throw new Error("API connection needs an API base URL");
  return {
    url: normalizeApiUrl(config.url),
    key: typeof config.key === "string" ? config.key : "",
    model: typeof config.model === "string" ? config.model.trim() : "",
    ...(config.tools !== undefined ? { tools: config.tools as boolean } : {}),
  };
}

export const ApiKeyDriver: ProviderDriver<ApiKeyConfig> = {
  driverKind: API_KEY_DRIVER,
  metadata: { displayName: "API key", supportsMultipleInstances: true, access: "subscription" },
  models: { default: "", options: [] },
  install: { signInCommand: "Add the provider's API key in Settings → Engines → Add a model." },
  decodeConfig,
  // Never part of the default fleet: there is nothing to run without a key.
  defaultConfig: () => ({ url: "https://api.openai.com/v1", key: "", model: "" }),

  async create(input) {
    const { config } = input;
    const seed = (): ModelCatalog => ({
      default: config.model,
      options: config.model ? [{ id: config.model, label: config.model }] : [],
    });
    let catalog = seed();
    const refresh = async () => {
      if (!config.key) return;
      try {
        const options = await fetchSetupModels(config.url, config.key);
        if (config.model && !options.some((option) => option.id === config.model)) {
          options.unshift({ id: config.model, label: config.model });
        }
        catalog = { default: config.model || options[0].id, options };
      } catch {
        // Opportunistic: keep the saved default model when the list fails.
        catalog = seed();
      }
    };
    if (config.key) void refresh();
    return createOpenAIChatRuntime({
      input,
      driverKind: API_KEY_DRIVER,
      apiKey: config.key,
      apiUrl: config.url,
      tools: config.tools,
      models: () => catalog,
      refreshModels: refresh,
      redirect: "error",
      requestBody: (model, messages, stream) => ({
        model,
        messages,
        stream,
        stream_options: stream ? { include_usage: true } : undefined,
      }),
      httpErrorLabel: "provider",
      missingKeyError: "no API key — add it again in Settings → Engines",
      unavailableReason: "no API key — add it again in Settings → Engines",
      timeoutMs: 180_000,
      reasoning: true,
      billing: "metered",
      includeUsageInCompleted: true,
      nativeLog: {
        source: "api-key.chat.completions",
        outgoing: (_turn, messages, model) => ({ model, messageCount: messages.length }),
        incoming: ({ text, reasoning, usage }) => ({ textLength: text.length, reasoningLength: reasoning.length, usage }),
      },
    });
  },
};
