import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import bundled from "../shared/marketplace-catalog.json" with { type: "json" };
import {
  MARKETPLACE_URL,
  addRentRequest,
  bundledMarketplace,
  listRentRequests,
  loadMarketplace,
  marketplaceEntry,
  marketplaceUrl,
  parseMarketplaceCatalog,
  parsePublishInput,
  resetMarketplaceCache,
  withCatalogEntry,
  writePublishedCatalog,
} from "./marketplace.ts";

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

let dir: string;
beforeEach(() => {
  resetMarketplaceCache();
  dir = mkdtempSync(join(tmpdir(), "bos-marketplace-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("marketplace catalog", () => {
  it("bundles at least one BOS-published bot with a valid package", () => {
    const catalog = bundledMarketplace();
    expect(catalog.publisher.name).toBe("BOS Bot");
    expect(catalog.bots.length).toBe(bundled.bots.length);
    const bos = catalog.bots.find((bot) => bot.slug === "bos")!;
    expect(bos.package.package.agents[0]!.soul).toContain("co-founder");
    expect(bos.package.package.skills?.entries.map((skill) => skill.name)).toEqual(["done-check"]);
    expect(bos.model).toEqual({ driverKind: "claude", model: "claude-opus-5-5" });
    expect(bos.price.download).toBeTruthy();
  });

  it("drops a broken entry without emptying the shelf", () => {
    const catalog = parseMarketplaceCatalog({
      ...bundled,
      bots: [...bundled.bots, { ...bundled.bots[0], slug: "broken", package: { format: "openmaus.package", version: 1, package: {} } }, bundled.bots[0]],
    });
    expect(catalog.bots.map((bot) => bot.slug)).toEqual(["bos"]);
  });

  it("rejects a document that is not a catalog", () => {
    expect(() => parseMarketplaceCatalog({ format: "openmaus.catalog", version: 1, teams: [] })).toThrow(/not a BOS marketplace/);
  });

  it("uses the hosted copy when it answers", async () => {
    const hosted = { ...bundled, updatedAt: "2099-01-01" };
    const fetcher = vi.fn(async () => json(hosted));
    const listing = await loadMarketplace({ fetch: fetcher as never, env: {} });
    expect(fetcher).toHaveBeenCalledWith(MARKETPLACE_URL, expect.objectContaining({ redirect: "error" }));
    expect(listing.source).toBe("hosted");
    expect(listing.catalog.updatedAt).toBe("2099-01-01");
  });

  it("falls back to the bundled copy and says why", async () => {
    const listing = await loadMarketplace({ fetch: (async () => json({}, 404)) as never, env: {} });
    expect(listing.source).toBe("bundled");
    expect(listing.error).toMatch(/404/);
    expect(listing.catalog.bots[0]!.slug).toBe("bos");
  });

  it("caches a fetch and can be switched off", async () => {
    const fetcher = vi.fn(async () => json(bundled));
    await loadMarketplace({ fetch: fetcher as never, env: {}, now: () => 1_000 });
    await loadMarketplace({ fetch: fetcher as never, env: {}, now: () => 2_000 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(marketplaceUrl({ BOS_MARKETPLACE_URL: "off" })).toBeNull();
    expect(marketplaceUrl({ BOS_MARKETPLACE_URL: "http://plain.example/x.json" })).toBeNull();
    const off = await loadMarketplace({ fetch: fetcher as never, env: { BOS_MARKETPLACE_URL: "off" } });
    expect(off.source).toBe("bundled");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("rent requests", () => {
  it("keeps a request as pending for a rentable bot", async () => {
    const catalog = bundledMarketplace();
    const request = await addRentRequest(dir, catalog, { slug: "bos", note: "for my agency" }, 5);
    expect(request).toMatchObject({ slug: "bos", name: "bos", note: "for my agency", status: "pending", createdAt: 5 });
    expect(await listRentRequests(dir)).toEqual([request]);
  });

  it("refuses unknown bots and bots without a rent offer", async () => {
    const catalog = bundledMarketplace();
    await expect(addRentRequest(dir, catalog, { slug: "nope" })).rejects.toMatchObject({ status: 404 });
    const noRent = { ...catalog, bots: catalog.bots.map((bot) => ({ ...bot, price: { download: "Free" } })) };
    await expect(addRentRequest(dir, noRent, { slug: "bos" })).rejects.toMatchObject({ status: 400 });
  });
});

describe("publishing", () => {
  it("builds an entry from a package and merges it into the catalog", async () => {
    const catalog = bundledMarketplace();
    const publish = parsePublishInput({ botId: "b1", slug: "closer", tagline: "Closes warm leads on WhatsApp.", price: { download: "RM 99" }, terms: "One business per download." });
    const document = catalog.bots[0]!.package;
    const entry = marketplaceEntry({
      publish,
      document,
      bot: { name: "Closer", description: "Follows up every warm lead.", color: "blue", mascotBody: "star" },
      model: { driverKind: "codex", model: "gpt-5.5" },
    });
    expect(entry.package.package.id).toBe("closer");
    expect(entry.package.package.author.name).toBe("BOS Bot");
    expect(entry.avatar).toEqual({ color: "blue", body: "star" });
    const merged = withCatalogEntry(catalog, entry, "2026-10-13");
    expect(merged.bots.map((bot) => bot.slug)).toEqual(["bos", "closer"]);
    expect(withCatalogEntry(merged, { ...entry, tagline: "v2" }, "2026-10-14").bots.at(-1)!.tagline).toBe("v2");

    const file = await writePublishedCatalog(dir, merged);
    const reread = parseMarketplaceCatalog(JSON.parse(readFileSync(file, "utf8")));
    expect(reread.bots.map((bot) => bot.slug)).toEqual(["bos", "closer"]);
    expect(reread.updatedAt).toBe("2026-10-13");
  });

  it("names the field a publish request got wrong", () => {
    expect(() => parsePublishInput({ botId: "b1", slug: "Bad Slug", tagline: "x", price: { download: "Free" }, terms: "t" })).toThrow(/slug/);
  });
});
