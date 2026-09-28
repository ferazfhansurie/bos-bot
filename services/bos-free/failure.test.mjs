import test from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let mode = 'reset';
const up = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  let b = ''; req.on('data', (c) => b += c); req.on('end', () => {
    const model = JSON.parse(b).model;
    if (mode === 'reset') { mode = 'ok'; return req.socket.destroy(); }
    if (mode === 'hang') return;
    res.end(JSON.stringify({ model, choices: [{ message: { content: 'ok' } }] }));
  });
});
await new Promise((r) => up.listen(0, '127.0.0.1', r));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bosfree-fail-'));
Object.assign(process.env, { OPENROUTER_API_KEY: 'sk-owner', RETRY_BACKOFF_MS: '5', UPSTREAM: `http://127.0.0.1:${up.address().port}`, BOS_FREE_DATA: path.join(dir, 'd.json'), PER_INSTALL_DAILY: '5', GLOBAL_DAILY: '10', CHAT_PER_IP_DAILY: '10', UPSTREAM_ATTEMPTS: 'not-a-number' });
const { server } = await import('./server.mjs');
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/api/v1`;
const chat = (t, signal) => fetch(`${base}/chat/completions`, { method: 'POST', signal, headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'openrouter/free', messages: [{ role: 'user', content: 'x' }] }) });
const usage = async (t) => (await (await fetch(`${base}/usage`, { headers: { authorization: `Bearer ${t}` } })).json()).install;

test('network errors retry, disconnects refund, bad attempts env falls back', async () => {
  const { token } = await (await fetch(`${base}/register`, { method: 'POST' })).json();
  const r = await chat(token);
  assert.equal(r.status, 200, 'connection reset retried');
  assert.equal((await r.json()).model, 'deepseek/deepseek-v4.1-flash');
  assert.equal(await usage(token), 4);
  mode = 'hang';
  const ctl = new AbortController();
  const pending = chat(token, ctl.signal).catch(() => null);
  await new Promise((r) => setTimeout(r, 200)); ctl.abort(); await pending;
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(await usage(token), 4, 'disconnect before reply refunded');
  server.close(); up.closeAllConnections(); up.close();
});
