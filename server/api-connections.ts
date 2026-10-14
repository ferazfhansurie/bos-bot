// Settings → Engines → "Add a model": any provider that speaks the
// OpenAI-compatible Chat Completions API becomes its own `api-…` instance.
// The api-key driver lists the provider's /models for the picker, so one
// connection brings every model on that key; `model` is only its default.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { persistableInstanceConfigs, type AppConfig } from "./config.ts";
import type { InstanceConfig } from "./contracts.ts";
import { normalizeApiUrl } from "./cli-api-setup.ts";
import { API_KEY_DRIVER } from "./drivers/api-key.ts";
import { API_PROVIDER_IDS, API_PROVIDERS, type ApiProviderId } from "../shared/api-providers.ts";

const noControl = (value: string) => !/\p{Cc}/u.test(value);
// Header credentials: no control characters or whitespace.
// eslint-disable-next-line no-control-regex
const key = z.string().min(1).max(4096).refine((value) => !/[\u0000-\u0020\u007f]/u.test(value), "Enter the API key without spaces or line breaks.");
const provider = z.enum(API_PROVIDER_IDS);

export const apiModelsSchema = z.object({
  provider,
  url: z.string().trim().max(2048).optional(),
  key,
}).strict();

export const apiConnectionSchema = apiModelsSchema.extend({
  model: z.string().trim().min(1).max(256).refine(noControl, "Model ID cannot contain control characters"),
  name: z.string().trim().max(80).refine(noControl, "Name cannot contain control characters").optional(),
}).strict();

/** The provider's base URL: the preset's, or a validated custom one. */
export function apiConnectionUrl(body: { provider: ApiProviderId; url?: string }): string {
  const preset = API_PROVIDERS.find((entry) => entry.id === body.provider);
  if (preset) return preset.url;
  if (!body.url) throw Object.assign(new Error("Enter the provider's API base URL."), { status: 400 });
  try {
    return normalizeApiUrl(body.url);
  } catch (error) {
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { status: 400 });
  }
}

export function newApiConnection(cfg: AppConfig, body: z.infer<typeof apiConnectionSchema>) {
  const instances = persistableInstanceConfigs(cfg);
  const preset = API_PROVIDERS.find((entry) => entry.id === body.provider);
  const url = apiConnectionUrl(body);
  const label = body.name || preset?.label || new URL(url).hostname;
  const instanceId = `api-${randomUUID().slice(0, 8)}`;
  const entry: InstanceConfig = {
    driver: API_KEY_DRIVER,
    displayName: label,
    ...(preset?.icon ? { icon: { kind: "preset" as const, preset: preset.icon } } : {}),
    config: { url, key: body.key, model: body.model },
  };
  instances[instanceId] = entry;
  return { instanceId, instances };
}

/** Only connections added here are removable here; built-in engines stay. */
export function removableApiConnection(instanceId: string, entry: InstanceConfig | undefined): boolean {
  return /^api-[\w-]+$/u.test(instanceId) && entry?.driver === API_KEY_DRIVER;
}
