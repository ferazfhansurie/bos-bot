export const PRODUCT_EVENTS = [
  "install", "open", "app_opened", "engine_connected", "first_bot", "first_message", "first_job_done", "whatsapp_linked", "app_connected", "routine_created", "phone_paired", "mod_created", "mod_enabled", "update_installed", "heal_ran", "error", "pair_success", "push_ok",
  "call_started", "group_call_started", "room_members_changed", "onboarding_step", "onboarding_completed", "phone_setup_skipped", "phone_setup_completed", "email_skipped", "marketplace_rent_requested", "marketplace_downloaded", "team_imported", "marketplace_published", "bot_created", "message_sent", "room_created",
] as const;
export type ProductEventName = typeof PRODUCT_EVENTS[number];
export interface ProductEvent { name: ProductEventName; at: string; props: Record<string, number | boolean | string> }
const names = new Set<string>(PRODUCT_EVENTS);
const counts = new Set(["count", "members", "memberCount", "bots", "duration_ms"]);
const bools = new Set(["success", "room", "queued", "replay", "context"]);
const classes = ["engine", "network", "auth", "storage", "update", "push", "whatsapp", "server", "unknown"];
const enums: Record<string, readonly string[]> = { engine: ["claude", "codex", "bos-free", "other"], class: classes, check: classes,
  source: ["desktop", "ios", "android", "onboarding", "settings", "chat", "routine"], rating: ["up", "down"] };

/** Construct every field explicitly. Never forward opaque caller properties. */
export function productEvent(name: string, input?: Record<string, unknown>, now = Date.now()): ProductEvent | null {
  if (!names.has(name) || !Number.isFinite(now)) return null;
  const props: ProductEvent["props"] = {};
  for (const [key, value] of Object.entries(input ?? {}).slice(0, 40)) {
    if (counts.has(key) && typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000) props[key] = value;
    if (bools.has(key) && typeof value === "boolean") props[key] = value;
    if (typeof value === "string" && Object.hasOwn(enums, key) && enums[key].includes(value)) props[key] = value;
  }
  return { name: name as ProductEventName, at: new Date(now).toISOString(), props };
}
