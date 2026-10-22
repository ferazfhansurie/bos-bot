import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { selfHealEnabled } from "./self-heal-policy.mjs";

test("optional self-heal actions require the cached c1 flag; data protection never uses this gate", () => {
  const directory = mkdtempSync(join(tmpdir(), "bos-heal-policy-"));
  const file = join(directory, "app-config.json");
  try {
    assert.equal(selfHealEnabled(directory), false);
    for (const [config, expected] of [
      [{ version: 1, flags: { selfHeal: true } }, true],
      [{ version: 1, flags: { selfHeal: false } }, false],
      [{ version: 1, flags: { selfHeal: "true" } }, false],
      [{ version: 2, flags: { selfHeal: true } }, false],
    ]) {
      writeFileSync(file, JSON.stringify(config));
      assert.equal(selfHealEnabled(directory), expected);
    }
    writeFileSync(file, "broken");
    assert.equal(selfHealEnabled(directory), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
