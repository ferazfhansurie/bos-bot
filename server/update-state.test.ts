import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { readUpdateState } from "./update-state.ts";

it("reads only known update classes from a bounded desktop snapshot", () => {
  const dir = mkdtempSync(join(tmpdir(), "bos-update-read-"));
  try {
    expect(readUpdateState(dir)).toBe("idle");
    for (const value of ["checking", "downloading", "downloaded", "failed:network", "failed:feed", "failed:verification", "failed:install", "failed:unknown"]) {
      writeFileSync(join(dir, "update-state.json"), JSON.stringify({update_state: value}));
      expect(readUpdateState(dir)).toBe(value);
    }
    for (const raw of ['{"update_state":"failed:secret-token"}', 'bad', '"' + 'x'.repeat(2000) + '"']) {
      writeFileSync(join(dir, "update-state.json"), raw);
      expect(readUpdateState(dir)).toBe("idle");
    }
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
