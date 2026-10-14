// The BOS marketplace: bots BOS Bot itself publishes, nobody else's.
//
// The catalog is one JSON document. The app fetches the hosted copy from the
// public bos-bot repository and falls back to the copy bundled into this
// build, so the shelf is never empty offline or before the hosted file
// exists. Every entry carries a complete bot package; "download" sends that
// package through the ordinary additive /api/teams/import, so a catalog can
// never do more than a package file the person imported by hand.
//
// Renting has no backend yet: a request is kept locally as pending and the
// app hands the person a prefilled email to firaz. Publishing likewise has no
// authenticated upload: the owner's publish writes a merged catalog file
// that is committed to the repository by hand.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { z } from "zod";

import bundledCatalog from "../shared/marketplace-catalog.json" with { type: "json" };
import { compatEnv, compatEnvironment } from "../electron/branding-env.cjs";
import { parseBotPackage, type ParsedBotPackage } from "./bot-package.ts";
import { parseJson, type JsonValue } from "./schema.ts";

export const MARKETPLACE_FORMAT = "bos.marketplace" as const;
export const MARKETPLACE_URL =
  "https://raw.githubusercontent.com/ferazfhansurie/bos-bot/main/shared/marketplace-catalog.json";
const MAX_CATALOG_BYTES = 2_000_000;
const FETCH_TIMEOUT_MS = 8_000;
const CACHE_MS = 10 * 60_000;
const MAX_RENT_REQUESTS = 200;

const text = (max: number) => z.string().trim().min(1).max(max);
const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);

const entrySchema = z.object({
  slug,
  name: text(100),
  tagline: text(200),
  summary: text(4_000),
  category: text(80),
  avatar: z.object({ color: text(20), body: text(40).optional(), expression: text(80).optional() }),
  price: z.object({ download: text(80), rent: text(80).optional() }),
  terms: text(2_000),
  model: z.object({ driverKind: text(60), model: text(120), effort: text(40).optional() }).optional(),
  package: z.unknown(),
});

const catalogSchema = z.object({
  format: z.literal(MARKETPLACE_FORMAT),
  version: z.literal(1),
  publisher: z.object({ name: text(100), contact: text(200).optional(), url: text(500).optional() }),
  updatedAt: text(40).optional(),
  bots: z.array(z.unknown()).max(200),
});

export type MarketplaceEntry = Omit<z.infer<typeof entrySchema>, "package"> & { package: ParsedBotPackage };
export interface MarketplaceCatalog {
  format: typeof MARKETPLACE_FORMAT;
  version: 1;
  publisher: z.infer<typeof catalogSchema>["publisher"];
  updatedAt?: string;
  bots: MarketplaceEntry[];
}
export interface MarketplaceListing {
  catalog: MarketplaceCatalog;
  source: "hosted" | "bundled";
  /** why the hosted copy was not used, when it was not */
  error?: string;
}

/** Validate a catalog document. A broken entry is dropped on its own (one bad
 * bot must not empty the shelf); a broken document throws. */
export function parseMarketplaceCatalog(value: unknown): MarketplaceCatalog {
  const parsed = catalogSchema.safeParse(value);
  if (!parsed.success) throw new Error("This is not a BOS marketplace catalog");
  const seen = new Set<string>();
  const bots: MarketplaceEntry[] = [];
  for (const raw of parsed.data.bots) {
    const entry = entrySchema.safeParse(raw);
    if (!entry.success || seen.has(entry.data.slug)) continue;
    let pkg: ParsedBotPackage;
    try {
      pkg = parseBotPackage(entry.data.package as JsonValue);
    } catch {
      continue;
    }
    seen.add(entry.data.slug);
    bots.push({ ...entry.data, package: pkg });
  }
  return { ...parsed.data, bots };
}

export function bundledMarketplace(): MarketplaceCatalog {
  return parseMarketplaceCatalog(bundledCatalog);
}

/** `BOS_MARKETPLACE_URL` overrides the hosted copy (an https URL), or turns
 * the fetch off with `off` so tests and fixtures stay on the bundled copy. */
export function marketplaceUrl(env: NodeJS.ProcessEnv = compatEnv): string | null {
  const override = compatEnvironment(env).BOS_MARKETPLACE_URL?.trim();
  if (override === "off") return null;
  if (!override) return MARKETPLACE_URL;
  try {
    return new URL(override).protocol === "https:" ? override : null;
  } catch {
    return null;
  }
}

async function fetchHosted(url: string, fetcher: typeof fetch): Promise<MarketplaceCatalog> {
  const response = await fetcher(url, {
    headers: { accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`the hosted catalog answered HTTP ${response.status}`);
  if (Number(response.headers.get("content-length") ?? 0) > MAX_CATALOG_BYTES) throw new Error("the hosted catalog is too large");
  const raw = await response.text();
  if (Buffer.byteLength(raw) > MAX_CATALOG_BYTES) throw new Error("the hosted catalog is too large");
  let document: JsonValue;
  try {
    document = parseJson(raw);
  } catch {
    throw new Error("the hosted catalog is not valid JSON");
  }
  return parseMarketplaceCatalog(document);
}

let cached: { at: number; url: string; listing: MarketplaceListing } | null = null;

/** The hosted catalog when it answers, else the bundled one. Never throws. */
export async function loadMarketplace(options: { fetch?: typeof fetch; env?: NodeJS.ProcessEnv; now?: () => number; fresh?: boolean } = {}): Promise<MarketplaceListing> {
  const now = options.now?.() ?? Date.now();
  const url = marketplaceUrl(options.env);
  if (!url) return { catalog: bundledMarketplace(), source: "bundled" };
  if (!options.fresh && cached && cached.url === url && now - cached.at < CACHE_MS) return cached.listing;
  let listing: MarketplaceListing;
  try {
    listing = { catalog: await fetchHosted(url, options.fetch ?? fetch), source: "hosted" };
  } catch (error) {
    listing = { catalog: bundledMarketplace(), source: "bundled", error: error instanceof Error ? error.message : String(error) };
  }
  cached = { at: now, url, listing };
  return listing;
}

export function resetMarketplaceCache(): void {
  cached = null;
}

// ── rent requests ────────────────────────────────────────────────────────

export interface RentRequest {
  id: string;
  slug: string;
  name: string;
  note?: string;
  contact?: string;
  status: "pending";
  createdAt: number;
}

const rentInput = z.object({
  slug,
  note: z.string().trim().max(2_000).optional(),
  contact: z.string().trim().max(200).optional(),
});

const rentFile = (dataDir: string) => join(dataDir, "marketplace-rent-requests.json");

export async function listRentRequests(dataDir: string): Promise<RentRequest[]> {
  try {
    const value = JSON.parse(await readFile(rentFile(dataDir), "utf8")) as { requests?: unknown };
    return Array.isArray(value.requests) ? (value.requests as RentRequest[]) : [];
  } catch {
    return [];
  }
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, file);
}

/** Keep a rent request as pending. There is no rent backend yet, so the
 * request lives here until firaz answers the email the app prefills. */
export async function addRentRequest(dataDir: string, catalog: MarketplaceCatalog, body: unknown, now = Date.now()): Promise<RentRequest> {
  const input = rentInput.safeParse(body);
  if (!input.success) throw Object.assign(new Error("Choose a marketplace bot to rent"), { status: 400 });
  const entry = catalog.bots.find((bot) => bot.slug === input.data.slug);
  if (!entry) throw Object.assign(new Error("That bot is not in the marketplace"), { status: 404 });
  if (!entry.price.rent) throw Object.assign(new Error(`${entry.name} is not offered for rent`), { status: 400 });
  const request: RentRequest = {
    id: randomUUID(),
    slug: entry.slug,
    name: entry.name,
    ...(input.data.note ? { note: input.data.note } : {}),
    ...(input.data.contact ? { contact: input.data.contact } : {}),
    status: "pending",
    createdAt: now,
  };
  const requests = [...(await listRentRequests(dataDir)), request].slice(-MAX_RENT_REQUESTS);
  await writeJsonAtomic(rentFile(dataDir), { requests });
  return request;
}

// ── publishing ───────────────────────────────────────────────────────────

const publishInput = z.object({
  botId: z.string().min(1).max(100),
  slug,
  tagline: text(200),
  category: text(80).default("Co-founder"),
  price: z.object({ download: text(80), rent: text(80).optional() }),
  terms: text(2_000),
});
export type PublishInput = z.infer<typeof publishInput>;

export function parsePublishInput(body: unknown): PublishInput {
  const parsed = publishInput.safeParse(body);
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path.join(".") || "request";
    throw Object.assign(new Error(`Check the ${field} field`), { status: 400 });
  }
  return parsed.data;
}

/** One catalog entry from an exported single-bot package plus the bot's
 * model. The package keeps its own validation; the listing copy is ours. */
export function marketplaceEntry(input: {
  publish: PublishInput;
  document: ParsedBotPackage;
  bot: { name: string; description?: string | null; color?: string | null; mascotBody?: string | null; mascotExpression?: string | null };
  model?: { driverKind: string; model: string; effort?: string };
}): MarketplaceEntry {
  const { publish, document, bot } = input;
  const summary = bot.description?.trim() || publish.tagline;
  const pkg = parseBotPackage({
    ...document,
    package: {
      ...document.package,
      id: publish.slug,
      name: bot.name,
      tagline: publish.tagline.slice(0, 160),
      summary: summary.slice(0, 2_000),
      category: publish.category,
      author: { name: "BOS Bot", url: "https://github.com/ferazfhansurie/bos-bot" },
      license: "BOS Bot marketplace terms",
    },
  });
  return {
    slug: publish.slug,
    name: bot.name,
    tagline: publish.tagline,
    summary,
    category: publish.category,
    avatar: {
      color: bot.color ?? "white",
      ...(bot.mascotBody ? { body: bot.mascotBody } : {}),
      ...(bot.mascotExpression ? { expression: bot.mascotExpression } : {}),
    },
    price: publish.price,
    terms: publish.terms,
    ...(input.model ? { model: input.model } : {}),
    package: pkg,
  };
}

/** The catalog with `entry` added, or replacing the entry with its slug. */
export function withCatalogEntry(catalog: MarketplaceCatalog, entry: MarketplaceEntry, today: string): MarketplaceCatalog {
  const bots = catalog.bots.some((bot) => bot.slug === entry.slug)
    ? catalog.bots.map((bot) => (bot.slug === entry.slug ? entry : bot))
    : [...catalog.bots, entry];
  return { ...catalog, updatedAt: today, bots };
}

export const publishedCatalogFile = (dataDir: string) => join(dataDir, "marketplace", "marketplace-catalog.json");

/** Write the merged catalog for the owner to commit. Validated on the way
 * out, so the file on disk always parses as a catalog. */
export async function writePublishedCatalog(dataDir: string, catalog: MarketplaceCatalog): Promise<string> {
  const checked = parseMarketplaceCatalog(JSON.parse(JSON.stringify(catalog)));
  if (checked.bots.length !== catalog.bots.length) throw new Error("A catalog entry did not validate");
  const file = publishedCatalogFile(dataDir);
  await writeJsonAtomic(file, checked);
  return file;
}
