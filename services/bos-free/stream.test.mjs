import test from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sse = (o) => `data: ${JSON.stringify(o)}\n\n`;
let seen = [];
const up = http.createServer((req, res) => {
  if (req.url.endsWith('/models')) { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ data: [
    { id: 'openrouter/free', pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] },
    { id: 'mid/fail:free', pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] },
    { id: 'err/body:free', pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] },
    { id: 'good/one:free', pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] },
  ] })); }
  let b = ''; req.on('data', (c) => b += c); req.on('end', () => {
    const body = JSON.parse(b); seen.push(body.model);
    if (body.model !== 'good/one:free' && !body.stream) { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ error: { message: 'Upstream error from X: overloaded' } })); }
    if (body.model !== 'good/one:free') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(sse({ choices: [{ delta: { reasoning: 'thinking about it' } }] }));
      return setTimeout(() => { res.write(sse({ error: { message: 'Upstream error from Nvidia: Service temporarily overloaded' }, choices: [{ delta: {}, finish_reason: 'error' }] })); res.end(); }, 30);
    }
    if (!body.stream) { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ model: body.model, choices: [{ message: { content: 'hi' } }] })); }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(sse({ choices: [{ delta: { reasoning: 'ok' } }] }));
    res.write(sse({ model: body.model, choices: [{ delta: { content: 'hello there' } }] }));
    res.write(sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }));
    res.end('data: [DONE]\n\n');
  });
});
await new Promise((r) => up.listen(0, '127.0.0.1', r));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bosfree-stream-'));
Object.assign(process.env, { OPENROUTER_API_KEY: 'sk-owner', UPSTREAM: `http://127.0.0.1:${up.address().port}`, BOS_FREE_DATA: path.join(dir, 'd.json'), PER_INSTALL_DAILY: '5', GLOBAL_DAILY: '10', CHAT_PER_IP_DAILY: '10', UPSTREAM_ATTEMPTS: '4' });
const { server } = await import('./server.mjs');
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/api/v1`;
const chat = (t, model, stream) => fetch(`${base}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: JSON.stringify({ model, stream, messages: [{ role: 'user', content: 'x' }] }) });
const usage = async (t) => (await (await fetch(`${base}/usage`, { headers: { authorization: `Bearer ${t}` } })).json()).install;

test('an error mid-stream before any answer moves to the next free model', async () => {
  try {
    const { token } = await (await fetch(`${base}/register`, { method: 'POST' })).json();
    const r = await chat(token, 'mid/fail:free', true);
    assert.equal(r.status, 200);
    const text = await r.text();
    assert.equal(seen[0], 'mid/fail:free');
    assert(text.includes('hello there'), 'answer from a working free model');
    assert(!text.includes('thinking about it'), 'failed attempt never reaches the app');
    assert(!text.includes('"error"'));
    assert.equal(await usage(token), 4, 'counted once');
    seen = [];
    const plain = await chat(token, 'err/body:free', false);
    assert.equal(plain.status, 200);
    assert.equal((await plain.json()).choices[0].message.content, 'hi', '200 with error body is retried');
  } finally { server.close(); up.close(); }
});
