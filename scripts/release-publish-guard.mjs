// Dependency-free so publication runners can gate downloaded assets without
// installing the application. Accept only electron-builder's stable version scalar.
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function desktopFeedVersion(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => /^version:/.test(line));
  assert.equal(lines.length, 1, 'feed must contain exactly one top-level version');
  const match = lines[0].match(/^version:\s*(?:"(\d+\.\d+\.\d+)"|'(\d+\.\d+\.\d+)'|(\d+\.\d+\.\d+))\s*(?:#.*)?$/);
  assert.ok(match, 'feed version must be a stable semantic version');
  return match[1] ?? match[2] ?? match[3];
}

export function verifyDesktopRelease(feedDir, expectedVersion) {
  const mac = desktopFeedVersion(readFileSync(join(feedDir, 'latest-mac.yml'), 'utf8'));
  const windows = desktopFeedVersion(readFileSync(join(feedDir, 'latest.yml'), 'utf8'));
  assert.equal(windows, mac, 'mac and Windows feeds must ship the same version');
  if (expectedVersion !== undefined) assert.equal(mac, expectedVersion, 'feeds differ from the release version');
  for (const suffix of ['arm64.zip', 'arm64.dmg', 'x64.zip', 'x64.dmg', 'setup.exe', 'setup.exe.blockmap']) {
    const file = join(feedDir, `BOS-Bot-${mac}-${suffix}`);
    const stat = statSync(file);
    assert.ok(stat.isFile() && stat.size > 0, `missing or empty desktop artifact: ${file}`);
  }
  return mac;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [feedDir, version, ...extra] = process.argv.slice(2);
  assert.ok(feedDir && extra.length === 0, 'usage: node scripts/release-publish-guard.mjs <feedDir> [version]');
  console.log(`desktop publication guard verified ${verifyDesktopRelease(feedDir, version)} for mac and Windows`);
}
