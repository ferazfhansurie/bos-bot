import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { registerPathDir, resetPathCacheForTests } from "./env-path.ts";
import { mediaTool } from "./video-probe.ts";

const dir = mkdtempSync(join(tmpdir(), "video-probe-"));
afterAll(() => { resetPathCacheForTests(); rmSync(dir, { recursive: true, force: true }); });

describe("mediaTool", () => {
  it("finds tools in user install folders a Finder launch never inherits", () => {
    delete process.env.BOSBOT_MAGICK;
    const fake = join(dir, "magick");
    writeFileSync(fake, "#!/bin/sh\n");
    chmodSync(fake, 0o755);
    registerPathDir(dir); // stands in for ~/.local/bin: not on process.env.PATH
    expect(mediaTool("magick")).toBe(fake);
  });
});
