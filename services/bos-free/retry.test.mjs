import test from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let calls = 0; let plan = [];
const up = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  let b = ''; req.on('data', (c) => b += c); req.on('end', () => {
    calls++; const step = plan.shift() || 'ok';
    if (step === 'busy') { res.statusCode = 429; return res.end(JSON.stringify({ error: { message: 'Rate limit reached', code: 'rate_limit_exceeded' } })); }
    if (step === 'quota') { res.statusCode = 429; return res.end(JSON.stringify({ error: { message: 'You exceeded your current quota', code: 'insufficient_quota' } })); }
    if (step === 'bad') { res.statusCode = 400; return res.end(JSON.stringify({ error: { message: 'Invalid schema', code: 'invalid_request_error' } })); }
    if (step === '5xx') { res.statusCode = 503; return res.end(JSON.stringify({ error: { message: 'overloaded' } })); }
    res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
  });
});
await new Promise((r) => up.listen(0, '127.0.0.1', r));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bosfree-retry-'));
Object.assign(process.env, { OPENAI_API_KEY: 'sk-owner', UPSTREAM: `http://127.0.0.1:${up.address().port}`, BOS_FREE_DATA: path.join(dir, 'd.json'), PER_INSTALL_DAILY: '5', GLOBAL_DAILY: '10', CHAT_PER_IP_DAILY: '10', RETRY_BACKOFF_MS: '5' });
const { server, MODEL_ID } = await import('./server.mjs');
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/api/v1`;
const chat = (t) => fetch(`${base}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: MODEL_ID, messages: [{ role: 'user', content: 'x' }] }) });
const usage = async (t) => (await (await fetch(`${base}/usage`, { headers: { authorization: `Bearer ${t}` } })).json()).install;

test('busy and 5xx retry luna with backoff; quota and bad requests fail fast and refund', async () => {
  try {
    const { token } = await (await fetch(`${base}/register`, { method: 'POST' })).json();
    plan = ['busy', '5xx']; calls = 0;
    assert.equal((await chat(token)).status, 200, 'third try answers');
    assert.equal(calls, 3);
    assert.equal(await usage(token), 4, 'counted once');
    plan = ['quota']; calls = 0;
    const q = await chat(token);
    assert.equal(q.status, 429); assert.equal(calls, 1, 'out of credit is not retried');
    assert.equal(await usage(token), 4, 'refunded');
    plan = ['bad']; calls = 0;
    assert.equal((await chat(token)).status, 400); assert.equal(calls, 1, '400 is not retried');
    plan = ['busy', 'busy', 'busy']; calls = 0;
    assert.equal((await chat(token)).status, 429); assert.equal(calls, 3, 'bounded retries');
    assert.equal(await usage(token), 4);
  } finally { server.close(); up.close(); }
});
