import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isMarketerLink, marketerIntentStore } from './marketer-link.mjs';
import { PACKAGE_SCHEME } from './release-channel.mjs';
test('only a parameter-free public marketer intent is accepted', () => {
  const base = `${PACKAGE_SCHEME}://offer/digital-marketer`;
  assert.equal(isMarketerLink(base), true);
  for (const suffix of ['?lead=other', '?paid=true', '#token=x', '/extra']) assert.equal(isMarketerLink(base + suffix), false);
  assert.equal(isMarketerLink('https://offer/digital-marketer'), false);
  assert.equal(isMarketerLink(`${PACKAGE_SCHEME}://user@offer/digital-marketer`), false);
});
test('offer survives restart, expires and can be explicitly dismissed', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bos-marketer-link-'));
  let now = 1_000;
  try {
    const store = marketerIntentStore(directory, () => now);
    assert.equal(store.pending(), false); store.remember();
    assert.equal(marketerIntentStore(directory, () => now).pending(), true);
    now += 8 * 86_400_000; assert.equal(store.pending(), false);
    store.remember(); store.clear(); assert.equal(store.pending(), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
