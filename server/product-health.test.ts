import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { productHealth } from "./product-health.ts";
it("omits unavailable or corrupt health, keeps real zero and typed update outcomes", () => {
  const dir = mkdtempSync(join(tmpdir(), "bos-product-health-"));
  try {
    expect(productHealth(dir)).toEqual({});
    writeFileSync(join(dir, "crash-count.json"), JSON.stringify({ count: 0, secret: "private" }));
    writeFileSync(join(dir, "update-state.json"), JSON.stringify({ update_state: "failed:feed", error: "private" }));
    expect(productHealth(dir)).toEqual({ crash_count: 0, update_state: "failed:feed" });
    writeFileSync(join(dir, "update-state.json"), JSON.stringify({ update_state: "failed:private error" }));
    writeFileSync(join(dir, "crash-count.json"), "bad");
    expect(productHealth(dir)).toEqual({});
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
