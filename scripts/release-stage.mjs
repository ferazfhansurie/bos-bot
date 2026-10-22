// Change the native electron-updater rollout on both desktop feeds together.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseDocument } from 'yaml';
import { verifyDesktopRelease } from './release-publish-guard.mjs';

export function stageDesktopRelease(feedDir, percent) {
  assert.ok(typeof percent === 'string' && /^(?:0|[1-9]\d?|100)$/.test(percent), 'percentage must be an integer from 0 to 100');
  const version = verifyDesktopRelease(feedDir);
  // Parse and validate both before writing either feed, preserving comments and
  // the generated file order (mac architecture selection relies on that order).
  const feeds = ['latest-mac.yml', 'latest.yml'].map(name => {
    const file = join(feedDir, name);
    const document = parseDocument(readFileSync(file, 'utf8'));
    assert.equal(document.errors.length, 0, `${name}: invalid YAML`);
    document.set('stagingPercentage', Number(percent));
    return { file, text: String(document) };
  });
  for (const { file, text } of feeds) writeFileSync(file, text);
  return version;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [feedDir, percent, ...extra] = process.argv.slice(2);
  assert.ok(feedDir && percent !== undefined && extra.length === 0, 'usage: node scripts/release-stage.mjs <feedDir> <percent>');
  console.log(`staged desktop ${stageDesktopRelease(feedDir, percent)} at ${percent}% for mac and Windows`);
}
