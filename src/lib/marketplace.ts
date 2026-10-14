// Client side of the BOS marketplace (server/marketplace.ts owns the catalog).
//
// "Download" is the ordinary additive import followed by one bot patch for
// the model the listing recommends: packages never carry a model selection,
// so the recommendation is applied only when this computer has an engine that
// offers that exact model. Otherwise the bot keeps the default and the panel
// says so.
import { SUPPORT_EMAIL } from "./app-links";

export interface MarketplaceSkill {
  name: string;
  description?: string;
}

export interface MarketplaceApp {
  slug: string;
  label?: string;
  reason?: string;
  optional?: boolean;
}

export interface MarketplaceModel {
  driverKind: string;
  model: string;
  effort?: string;
}

export interface MarketplaceEntry {
  slug: string;
  name: string;
  tagline: string;
  summary: string;
  category: string;
  avatar: { color: string; body?: string; expression?: string };
  price: { download: string; rent?: string };
  terms: string;
  model?: MarketplaceModel;
  package: {
    format: string;
    version: number;
    package: {
      id: string;
      name: string;
      agents: Array<{ key: string; name: string; title?: string; skills?: string[] }>;
      skills?: { entries: MarketplaceSkill[] };
      requirements?: { apps?: MarketplaceApp[] };
    };
  };
}

export interface MarketplaceCatalog {
  format: "bos.marketplace";
  version: 1;
  publisher: { name: string; contact?: string; url?: string };
  updatedAt?: string;
  bots: MarketplaceEntry[];
}

export interface MarketplaceListing {
  catalog: MarketplaceCatalog;
  source: "hosted" | "bundled";
  error?: string;
  /** this person may publish (owner, flag on, not a peer client) */
  publisher: boolean;
}

/** The subset of InstanceInfo the model match reads. */
export interface ModelInstance {
  instanceId: string;
  driverKind: string;
  displayName: string;
  snapshot: { state: "available" | "unavailable" };
  models: { options: Array<{ id: string; label: string }> };
}

/** The first available engine of the recommended kind that offers the exact
 * model, as the selection PATCH /api/bots/:id takes; null when none does. */
export function pickModelSelection(
  model: MarketplaceModel | undefined,
  instances: readonly ModelInstance[],
): { instanceId: string; model: string; effort?: string; label: string } | null {
  if (!model) return null;
  for (const instance of instances) {
    if (instance.driverKind !== model.driverKind || instance.snapshot.state !== "available") continue;
    const option = instance.models.options.find((candidate) => candidate.id === model.model);
    if (!option) continue;
    return {
      instanceId: instance.instanceId,
      model: model.model,
      ...(model.effort ? { effort: model.effort } : {}),
      label: `${instance.displayName} · ${option.label}`,
    };
  }
  return null;
}

/** The email a rent request becomes. Renting has no backend yet, so this is
 * the channel: the request is kept locally as pending and the person sends
 * this to the publisher (the desktop shell opens only web links, so it is
 * copied rather than handed to a mailto). */
export function rentRequestEmail(entry: MarketplaceEntry, note: string, to = SUPPORT_EMAIL): { to: string; subject: string; body: string; text: string } {
  const subject = `Rent request: ${entry.name}`;
  const body = [
    `I'd like to rent ${entry.name} from the BOS marketplace.`,
    `Listed price: ${entry.price.rent ?? "not listed"}`,
    "",
    note.trim() || "What I need it for:",
  ].join("\n");
  return { to, subject, body, text: `To: ${to}\nSubject: ${subject}\n\n${body}` };
}

export const slugify = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "bot";
