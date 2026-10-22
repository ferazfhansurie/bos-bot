import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { recordCrashCount } from "./crash-count.mjs";

test("crash counts persist across callers in the workspace and contain only metadata", t => {
  const dir = mkdtempSync(path.join(tmpdir(), "bos-crash-count-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  recordCrashCount(dir); recordCrashCount(dir);
  const result = JSON.parse(readFileSync(path.join(dir, "crash-count.json"), "utf8"));
  assert.equal(result.count, 2);
  assert.deepEqual(Object.keys(result).sort(), ["count", "lastCrashAt"]);
  assert.ok(Number.isFinite(Date.parse(result.lastCrashAt)));
});
test("crash counter does not follow a file symlink", t => {
  const dir = mkdtempSync(path.join(tmpdir(), "bos-crash-count-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, "target");
  writeFileSync(target, '{"count":90}');
  symlinkSync(target, path.join(dir, "crash-count.json"));
  recordCrashCount(dir);
  assert.equal(readFileSync(target, "utf8"), '{"count":90}');
});
