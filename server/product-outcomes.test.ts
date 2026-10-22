import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ProductOutcomes } from "./product-outcomes.ts";
it("records real version changes, new crash counts and recent successful recovery once across restarts", () => {
  const dir = mkdtempSync(join(tmpdir(), "bos-product-outcomes-"));
  const events: Array<{ name: string; props?: Record<string, unknown> }> = [];
  const record = (name: string, props?: Record<string, unknown>) => { events.push({ name, props }); };
  let version = "2.1.2", now = 1_800_000_000_000;
  try {
    writeFileSync(join(dir, "crash-count.json"), JSON.stringify({ count: 2 }));
    new ProductOutcomes({ dataDir: dir, version: () => version, record, now: () => now }).observe();
    expect(events).toEqual([]);
    version = "2.1.3"; now += 10_000;
    writeFileSync(join(dir, "crash-count.json"), JSON.stringify({ count: 3 }));
    writeFileSync(join(dir, "recovery-notices.json"), JSON.stringify([
      { id: "bots.json", collection: "bots.json", status: "restored", at: now, detail: "private path" },
      { id: "groups.json", collection: "groups.json", status: "read-only", at: now },
    ]));
    const outcomes = new ProductOutcomes({ dataDir: dir, version: () => version, record, now: () => now });
    outcomes.observe(); outcomes.observe();
    new ProductOutcomes({ dataDir: dir, version: () => version, record, now: () => now }).observe();
    expect(events).toEqual([{ name: "update_installed", props: undefined }, { name: "error", props: { class: "server", count: 1 } }, { name: "heal_ran", props: { check: "storage" } }]);
    expect(JSON.stringify(events)).not.toContain("private");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
