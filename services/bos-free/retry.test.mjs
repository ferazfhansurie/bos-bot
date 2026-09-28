import test from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let seen = []; let limited = new Set(['openrouter/free', 'busy/one:free']);
const up = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [
    { id: 'openrouter/free', pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] },
    { id: 'busy/one:free', pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] },
    { id: 'ok/two:free', pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] },
    { id: 'paid/x', pricing: { prompt: '1', completion: '1' }, supported_parameters: ['tools'] },
  ] }));
  let b = ''; req.on('data', (c) => b += c); req.on('end', () => {
    const body = JSON.parse(b); seen.push(body.model);
    if (limited.has(body.model)) { res.statusCode = 429; return res.end(JSON.stringify({ error: { message: 'Provider returned error', metadata: { raw: `${body.model === 'openrouter/free' ? 'busy/one:free' : body.model} is temporarily rate-limited upstream.` } } })); }
    res.end(JSON.stringify({ model: body.model, choices: [{ message: { content: 'ok' } }] }));
  });
});
await new Promise((r) => up.listen(0, '127.0.0.1', r));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bosfree-retry-'));
Object.assign(process.env, { OPENROUTER_API_KEY: 'sk-owner', UPSTREAM: `http://127.0.0.1:${up.address().port}`, BOS_FREE_DATA: path.join(dir, 'd.json'), PER_INSTALL_DAILY: '5', GLOBAL_DAILY: '10', CHAT_PER_IP_DAILY: '10' });
const { server } = await import('./server.mjs');
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/api/v1`;
const chat = (t, model) => fetch(`${base}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'x' }] }) });
const usage = async (t) => (await (await fetch(`${base}/usage`, { headers: { authorization: `Bearer ${t}` } })).json()).install;

test('free router retries rate-limited free models, never paid, counts once', async () => {
  const { token } = await (await fetch(`${base}/register`, { method: 'POST' })).json();
  const r = await chat(token, 'openrouter/free');
  assert.equal(r.status, 200);
  assert.equal((await r.json()).model, 'ok/two:free');
  assert(!seen.includes('paid/x'));
  assert.equal(await usage(token), 4, 'one call counted');
  seen = [];
  const again = await chat(token, 'openrouter/free');
  assert.equal(again.status, 200);
  assert(!seen.includes('busy/one:free'), 'cooled model skipped');
  seen = [];
  const pinned = await chat(token, 'ok/two:free');
  assert.equal(pinned.status, 200);
  assert.deepEqual(seen, ['ok/two:free'], 'a chosen free model is tried first');
  limited.delete('openrouter/free'); seen = [];
  const busyPinned = await chat(token, 'busy/one:free');
  assert.equal(busyPinned.status, 200, 'a busy chosen model falls back to other free models');
  assert(!seen.includes('paid/x'));
  limited.add('openrouter/free');
  assert.equal(await usage(token), 1);
  limited = new Set(['openrouter/free', 'busy/one:free', 'ok/two:free']); seen = [];
  const allBusy = await chat(token, 'openrouter/free');
  assert.equal(allBusy.status, 429);
  assert.equal(await usage(token), 1, 'failed call refunded');
  server.close(); up.close();
});
