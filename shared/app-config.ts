/** Public, versioned contract consumed by desktop, mobile and the updater. */
export interface AppPricing {
  id: string; title: string; priceMYR: number; unit: string;
  status: "available" | "coming_soon"; url: string; description: string;
}
export interface StarterJob { id: string; title: string; prompt: string }
export interface AppConfig {
  version: 1;
  minVersion: { desktop: string; ios: string; android: string };
  flags: Record<"activationTelemetry" | "freeEngine" | "plans" | "invite" | "feedback" | "starterJobs" | "autoUpdates" | "selfHeal" | "mods", boolean>;
  banner: { id: string; text: string; url: string } | null;
  pricing: AppPricing[];
  starterJobs: StarterJob[];
  rollout: { desktop: number; ios: number; android: number };
}

export const DEFAULT_APP_CONFIG: AppConfig = {
  version: 1, minVersion: { desktop: "0.0.0", ios: "0.0.0", android: "0.0.0" },
  flags: { activationTelemetry: true, freeEngine: true, plans: true, invite: true, feedback: true, starterJobs: true, autoUpdates: false, selfHeal: false, mods: false },
  banner: null,
  pricing: [
    { id: "payg", title: "Pay as you go", priceMYR: 20, unit: "top-up · RM1/hour", status: "available", url: "https://bosbot.my/#pricing", description: "Prepaid credit for hosted BOS work." },
    { id: "managed", title: "Managed", priceMYR: 1500, unit: "/month", status: "available", url: "https://bosbot.my/#pricing", description: "A managed BOS workspace with setup and support." },
    { id: "cloud", title: "Cloud founding", priceMYR: 299, unit: "/month", status: "coming_soon", url: "https://bosbot.my/#pricing", description: "Always-on cloud workspace. Coming soon." },
  ],
  starterJobs: [{ id: "whatsapp-work-groups", title: "Summarise my work groups every morning", prompt: "Help me link WhatsApp and choose the work groups I want summarised every morning. Show a sample digest, then propose a morning routine for my review. Do not send messages to any group." }],
  rollout: { desktop: 100, ios: 100, android: 100 },
};

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const bounded = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
const safeUrl = (value: unknown): value is string => {
  if (!bounded(value, 2048)) return false;
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password; } catch { return false; }
};
export function parseAppConfig(value: unknown): AppConfig {
  const input = record(value);
  const result: AppConfig = structuredClone(DEFAULT_APP_CONFIG);
  if (input.version !== 1) return result;
  const minimums = record(input.minVersion), flags = record(input.flags), rollout = record(input.rollout);
  for (const platform of ["desktop", "ios", "android"] as const) {
    const minimum = minimums[platform];
    if (typeof minimum === "string" && /^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(minimum)) result.minVersion[platform] = minimum;
    const percent = rollout[platform];
    if (typeof percent === "number" && Number.isFinite(percent) && percent >= 0 && percent <= 100) result.rollout[platform] = percent;
  }
  for (const key of Object.keys(result.flags) as Array<keyof AppConfig["flags"]>) if (typeof flags[key] === "boolean") result.flags[key] = flags[key];
  const banner = record(input.banner);
  if (bounded(banner.id, 80) && bounded(banner.text, 500) && safeUrl(banner.url)) result.banner = { id: banner.id, text: banner.text, url: banner.url };
  if (Array.isArray(input.pricing) && input.pricing.length <= 10) {
    const pricing: AppPricing[] = [];
    for (const row of input.pricing) {
      const price = record(row);
      if (!bounded(price.id, 80) || !bounded(price.title, 100) || !bounded(price.unit, 100) || !bounded(price.description, 500) || !safeUrl(price.url) ||
          typeof price.priceMYR !== "number" || !Number.isFinite(price.priceMYR) || price.priceMYR < 0 || price.priceMYR > 1_000_000 || !["available", "coming_soon"].includes(String(price.status))) continue;
      pricing.push({ id: price.id, title: price.title, priceMYR: price.priceMYR, unit: price.unit, description: price.description, url: price.url, status: price.status as AppPricing["status"] });
    }
    if (pricing.length || input.pricing.length === 0) result.pricing = pricing;
  }
  if (Array.isArray(input.starterJobs) && input.starterJobs.length <= 20) result.starterJobs = input.starterJobs.flatMap(row => {
    const job = record(row);
    return bounded(job.id, 80) && bounded(job.title, 120) && bounded(job.prompt, 2000) ? [{ id: job.id, title: job.title, prompt: job.prompt }] : [];
  });
  return result;
}
