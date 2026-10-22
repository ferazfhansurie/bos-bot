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

test('browser jobs run in the desktop browser host and post their result', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bos-connector-test-'));
  const env = { id: randomUUID(), origin: 'https://example.invalid' };
  const sessionId = randomUUID(), environmentId = randomUUID(), grantId = randomUUID(), jobId = randomUUID(), badId = randomUUID();
  const file = path.join(directory, 'grants.json');
  await fs.writeFile(file, JSON.stringify({ version: 1, records: { [env.id]: { id: grantId, enabled: true, sessionId, environmentId, secret: 'a'.repeat(64), folders: [], terminal: false, computer: false, browser: true } } }));
  const connects = [], results = [], runs = [];
  const jobs = [
    { id: jobId, operation: { computer_id: grantId, action: 'browser_rpc', method: 'tools/call', params: { name: 'agent_browser_open' }, bot_id: 'env:bot', thread_id: 't', generation: 'g' } },
    { id: badId, operation: { computer_id: grantId, action: 'browser_rpc', method: 'shell/exec', thread_id: 't', generation: 'g' } },
  ];
  const client = createComputerSharing({ file, environments: () => [env], enabled: async () => true, validateFolders: async folders => folders,
    browserHost: { run: async (workspace, operation) => { runs.push([workspace.id, operation.method]); return { content: [{ type: 'text', text: 'opened' }] }; }, releaseWorkspace() {} },
    fetch: async (url, init) => {
      const body = init?.body ? JSON.parse(init.body) : undefined;
      if (url.endsWith('/api/auth/session')) return new Response(JSON.stringify({ kind: 'session', id: sessionId }));
      if (url.endsWith('/.well-known/openmausbot/environment')) return new Response(JSON.stringify({ environmentId, capabilities: { sharedComputers: true, sharedBrowser: true } }));
      if (url.endsWith('/connect')) { connects.push(body); return new Response('{}'); }
      if (url.endsWith('/result')) { results.push(body); return new Response('{}'); }
      if (url.endsWith('/poll')) { await delay(2); return new Response(JSON.stringify({ job: jobs.shift() ?? null })); }
      return new Response('{}');
    },
  });
  try {
    client.start();
    for (let n = 0; n < 200 && results.length < 2; n++) await delay(5);
    assert.equal(connects[0].browser, true);
    assert.deepEqual(runs, [[env.id, 'tools/call']]);
    assert.deepEqual(results.find(entry => entry.jobId === jobId).result, { content: [{ type: 'text', text: 'opened' }] });
    assert.equal(results.find(entry => entry.jobId === badId).result.isError, true);
  } finally { client.close(); await fs.rm(directory, { recursive: true }); }
});
