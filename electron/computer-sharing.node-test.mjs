import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createComputerSharing } from './computer-sharing.mjs';

test('headless connector opens its circuit after bounded connection failures', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bos-connector-test-'));
  const env = { id: randomUUID(), origin: 'https://example.invalid' };
  const file = path.join(directory, 'grants.json');
  let calls = 0;
  await fs.writeFile(file, JSON.stringify({ version: 1, records: { [env.id]: { id: randomUUID(), enabled: true, sessionId: randomUUID(), environmentId: randomUUID(), secret: 'a'.repeat(64), folders: [], terminal: true, computer: false } } }));
  const client = createComputerSharing({ file, environments: () => [env], enabled: async () => true, fetch: async () => { calls++; throw new Error('Offline fixture'); }, retryPolicy: { maxFailures: 3, initialDelayMs: 1, maxDelayMs: 2 } });
  try {
    client.start();
    for (let n = 0; n < 100 && !client.state(env.id).circuitOpen; n++) await delay(5);
    assert.equal(client.state(env.id).circuitOpen, true);
    assert.equal(client.state(env.id).connected, false);
    assert.equal(calls, 6);
    await delay(20);
    assert.equal(calls, 6, 'the circuit must stay open');
  } finally { client.close(); await fs.rm(directory, { recursive: true }); }
});

test('saving a scoped headless grant persists it without activating registration', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bos-connector-test-'));
  const env = { id: randomUUID(), origin: 'https://example.invalid' };
  const sessionId = randomUUID(), environmentId = randomUUID(), botId = randomUUID();
  const requests = [];
  const client = createComputerSharing({ file: path.join(directory, 'grants.json'), environments: () => [env], enabled: async () => true, validateFolders: async folders => folders,
    fetch: async url => {
      requests.push(url);
      return new Response(JSON.stringify(url.endsWith('/api/auth/session') ? { kind: 'session', id: sessionId } : { environmentId, capabilities: { sharedComputers: true } }));
    },
  });
  try {
    const info = await client.identity(env);
    await client.save(env, { folders: [], terminal: true, computer: false, allowedBotIds: [botId] }, info, { activate: false });
    const stored = JSON.parse(await fs.readFile(path.join(directory, 'grants.json'), 'utf8')).records[env.id];
    assert.deepEqual(stored.allowedBotIds, [botId]);
    assert.equal(stored.computer, false);
    assert.equal(requests.some(url => url.includes('/api/shared-computers/')), false);
  } finally { client.close(); await fs.rm(directory, { recursive: true }); }
});
