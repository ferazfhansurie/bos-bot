/**
 * Writes shared/glyph-faces.json and its iOS copy from shared/glyph-faces.ts.
 *
 * Run with `pnpm gen:glyphs`; `--check` exits 1 instead of writing when either
 * file is stale. shared/glyph-faces.test.ts holds both files to the same bytes.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { glyphFacesJson } from "../shared/glyph-faces.ts";

const TARGETS = [
  "../shared/glyph-faces.json",
  "../ios/Sources/CompanionCore/Resources/glyph-faces.json",
].map((path) => fileURLToPath(new URL(path, import.meta.url)));

const check = process.argv.includes("--check");
const json = glyphFacesJson();
let stale = 0;
for (const target of TARGETS) {
  let current: string | null = null;
  try { current = readFileSync(target, "utf8"); } catch { /* missing */ }
  if (current === json) continue;
  stale++;
  if (check) console.error(`stale: ${target}`);
  else { writeFileSync(target, json); console.log(`wrote ${target}`); }
}
if (check && stale) process.exit(1);
