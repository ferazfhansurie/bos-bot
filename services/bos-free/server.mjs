// BOS Free: hosted relay to OpenAI GPT-6 Luna. Holds the owner key server-side;
// installs get per-install tokens with daily caps. Only the one BOS Free model is ever called.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const PORT = Number(process.env.PORT || 3370);
const KEY = process.env.OPENAI_API_KEY || '';
const DATA = process.env.BOS_FREE_DATA || path.join(process.cwd(), 'data.json');
const PER_INSTALL = Number(process.env.PER_INSTALL_DAILY || 100);
// owner budget: at ~$0.001-0.002 a turn, 2000 turns/day stays within a few dollars
const GLOBAL = Number(process.env.GLOBAL_DAILY || 2000);
const REG_PER_IP = Number(process.env.REGISTER_PER_IP_DAILY || 2);
const CHAT_PER_IP = Number(process.env.CHAT_PER_IP_DAILY || 150);
const UPSTREAM = process.env.UPSTREAM || 'https://api.openai.com/v1';
const UPSTREAM_MODEL = process.env.BOS_FREE_MODEL || 'gpt-6-luna';
const MAX_BODY = 4 * 1024 * 1024;
const MAX_TOKENS = 4096;
const ATTEMPTS = Math.max(1, Math.floor(Number(process.env.UPSTREAM_ATTEMPTS) || 3));
const BACKOFF_MS = Number(process.env.RETRY_BACKOFF_MS ?? 800);
if (!KEY) { console.error('OPENAI_API_KEY missing'); process.exit(1); }

const today = () => new Date().toISOString().slice(0, 10);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
let db = { installs: {}, day: today(), global: 0, usage: {}, reg: {}, ipUsage: {} };
try { db = { ...db, ...JSON.parse(fs.readFileSync(DATA, 'utf8')) }; } catch {}
const save = () => { const t = DATA + '.tmp'; fs.writeFileSync(t, JSON.stringify(db), { mode: 0o600 }); fs.renameSync(t, DATA); };
const roll = () => { if (db.day !== today()) { db.day = today(); db.global = 0; db.usage = {}; db.reg = {}; db.ipUsage = {}; save(); } };

// Installed apps accept `openrouter/free` or an id ending in `:free`; the public id keeps that shape.
export const MODEL_ID = 'bos-free/gpt-6-luna:free';
export const MODEL = { id: MODEL_ID, name: 'BOS Free GPT-6 Luna', pricing: { prompt: '0', completion: '0', request: '0' }, supported_parameters: ['tools', 'tool_choice', 'reasoning'] };
// Older installs still ask for the OpenRouter free ids; they all get Luna now.
export const isFreeId = (id) => typeof id === 'string' && (id === 'openrouter/free' || /^[a-zA-Z0-9_./-]+:free$/.test(id));

// one model, so a busy or failing call retries the same model after a short backoff
const retryable = (status) => [408, 409, 429, 500, 502, 503, 504].includes(status);
const upstreamReason = (text) => { try { const e = JSON.parse(text).error || {}; return String(e.code || e.message || '').slice(0, 160); } catch { return ''; } };
// out of credit or over the org budget: retrying cannot help
const exhausted = (text) => /insufficient_quota|credit_balance_exhausted|billing_hard_limit/.test(text);
const wait = (ms, signal) => new Promise((resolve) => { const t = setTimeout(resolve, ms); signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true }); });

const KEEPALIVE_MS = Math.max(1000, Number(process.env.KEEPALIVE_MS) || 10_000);
const HOLD_MS = Math.max(1000, Number(process.env.HOLD_MS) || 40_000);
const HOLD_BYTES = 512 * 1024;
const bodyError = (text) => { try { const j = JSON.parse(text); return j && j.error ? (upstreamReason(text) || 'error') : ''; } catch { return ''; } };
// 'error' = the provider failed this attempt; 'answer' = real output started, stream it through
export function streamLine(line) {
  if (!line.startsWith('data:')) return null;
  const data = line.slice(5).trim();
  if (data === '[DONE]') return 'answer';
  let j; try { j = JSON.parse(data); } catch { return null; }
  if (j && j.error) return 'error';
  const choice = j?.choices?.[0]; const delta = choice?.delta || {};
  if (choice?.finish_reason === 'error') return 'error';
  if ((typeof delta.content === 'string' && delta.content) || (Array.isArray(delta.tool_calls) && delta.tool_calls.length) || choice?.finish_reason) return 'answer';
  return null;
}

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
};
const clientIp = (req) => String(req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '');
async function readJson(req) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > MAX_BODY) throw Object.assign(new Error('too large'), { status: 413 }); chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw Object.assign(new Error('invalid json'), { status: 400 }); }
}
const auth = (req) => {
  const m = /^Bearer\s+(bosf_[A-Za-z0-9_-]{20,})$/.exec(String(req.headers.authorization || ''));
  if (!m) return null; const id = sha(m[1]); return db.installs[id] ? id : null;
};
const remaining = (id) => ({ install: Math.max(0, PER_INSTALL - (db.usage[id] || 0)), global: Math.max(0, GLOBAL - db.global), resetsAt: `${today()}T24:00:00Z` });

// Only these request fields reach OpenAI; anything else (models, plugins, web search, audio) is dropped.
const ALLOWED = ['messages', 'stream', 'tools', 'tool_choice', 'stop', 'response_format', 'stream_options', 'parallel_tool_calls', 'seed'];
const MESSAGE_KEYS = ['role', 'content', 'name', 'tool_calls', 'tool_call_id'];
const EFFORTS = ['minimal', 'low', 'medium', 'high'];
// Text-only content and function tools: file/image parts and server tools can bill add-ons.
const textPart = (p) => p && typeof p === 'object' && p.type === 'text' && typeof p.text === 'string';
export function validContent(body) {
  if (!Array.isArray(body.messages) || body.messages.length > 500) return false;
  for (const m of body.messages) {
    if (!m || typeof m !== 'object') return false;
    const c = m.content;
    if (!(c === undefined || c === null || typeof c === 'string' || (Array.isArray(c) && c.every(textPart)))) return false;
  }
  if (body.tools !== undefined && !(Array.isArray(body.tools) && body.tools.length <= 128 && body.tools.every((t) => t && t.type === 'function' && t.function && typeof t.function.name === 'string'))) return false;
  return true;
}
export function sanitize(body) {
  const out = {};
  for (const k of ALLOWED) if (body[k] !== undefined) out[k] = body[k];
  // OpenRouter-only extras on history (reasoning, reasoning_details) are rejected by OpenAI
  out.messages = body.messages.map((m) => Object.fromEntries(MESSAGE_KEYS.filter((k) => m[k] !== undefined).map((k) => [k, m[k]])));
  out.model = UPSTREAM_MODEL;
  out.max_completion_tokens = Math.min(Number(body.max_completion_tokens || body.max_tokens) || MAX_TOKENS, MAX_TOKENS);
  const effort = body.reasoning_effort || body.reasoning?.effort;
  if (EFFORTS.includes(effort)) out.reasoning_effort = effort;
  if (out.stream === true) out.stream_options = { include_usage: true };
  else delete out.stream_options;
  return out;
}

export const server = http.createServer(async (req, res) => {
  try {
    roll();
    const url = new URL(req.url, 'http://x');
    const p = url.pathname.replace(/\/+$/, '');
    if (req.method === 'GET' && p === '/health') return send(res, 200, { ok: true });
    if (req.method === 'POST' && p === '/api/v1/register') {
      const ip = sha(clientIp(req));
      if ((db.reg[ip] || 0) >= REG_PER_IP) return send(res, 429, { error: { message: 'Too many registrations today' } });
      const token = 'bosf_' + crypto.randomBytes(32).toString('base64url');
      db.installs[sha(token)] = { created: new Date().toISOString() };
      db.reg[ip] = (db.reg[ip] || 0) + 1; save();
      return send(res, 200, { token, limits: { perInstallDaily: PER_INSTALL } });
    }
    const id = auth(req);
    if (!id) return send(res, 401, { error: { message: 'BOS Free token required' } });
    if (req.method === 'GET' && p === '/api/v1/usage') return send(res, 200, remaining(id));
    if (req.method === 'GET' && p === '/api/v1/models') return send(res, 200, { data: [MODEL] });
    if (req.method === 'POST' && p === '/api/v1/chat/completions') {
      const body = await readJson(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) return send(res, 400, { error: { message: 'Invalid request' } });
      if (!validContent(body)) return send(res, 400, { error: { message: 'BOS Free supports text messages and function tools only' } });
      if (!isFreeId(body.model)) return send(res, 400, { error: { message: 'Only BOS Free GPT-6 Luna is available' } });
      if ((db.usage[id] || 0) >= PER_INSTALL) return send(res, 429, { error: { message: 'Daily BOS Free limit reached for this install' } }, { 'x-bos-free-remaining': '0' });
      const ip = sha(clientIp(req));
      if ((db.ipUsage[ip] || 0) >= CHAT_PER_IP) return send(res, 429, { error: { message: 'Daily BOS Free limit reached for this network' } }, { 'x-bos-free-remaining': '0' });
      if (db.global >= GLOBAL) return send(res, 429, { error: { message: 'BOS Free is at capacity today' } }, { 'x-bos-free-remaining': '0' });
      db.usage[id] = (db.usage[id] || 0) + 1; db.ipUsage[ip] = (db.ipUsage[ip] || 0) + 1; db.global += 1; save();
      // Upstream refusals, network failures and disconnects before a reply don't spend the caller's allowance.
      let refunded = false;
      const refund = () => { if (refunded) return; refunded = true; db.usage[id] = Math.max(0, (db.usage[id] || 0) - 1); db.ipUsage[ip] = Math.max(0, (db.ipUsage[ip] || 0) - 1); db.global = Math.max(0, db.global - 1); save(); };
      const ctl = new AbortController(); res.on('close', () => { if (!res.writableFinished) ctl.abort(); });
      const tries = Array.from({ length: ATTEMPTS }, () => UPSTREAM_MODEL);
      const stream = body.stream === true;
      let opened = false; let keep = null;
      const open = () => {
        if (opened) return; opened = true;
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-bos-free-remaining': String(remaining(id).install) });
        keep = setInterval(() => res.write(': bos-free\n\n'), KEEPALIVE_MS);
      };
      const stop = () => { if (keep) clearInterval(keep); keep = null; };
      const fail = (status, text) => {
        refund(); stop();
        if (!opened) { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-bos-free-remaining': String(remaining(id).install) }); return res.end(text); }
        res.write(`data: ${JSON.stringify({ error: { code: status, message: upstreamReason(text) || `HTTP ${status}` } })}\n\n`); return res.end();
      };
      try {
        for (let i = 0; i < tries.length; i++) {
          const last = i === tries.length - 1;
          let up;
          if (i) { await wait(BACKOFF_MS * i, ctl.signal); if (ctl.signal.aborted) throw new Error('aborted'); }
          try {
            up = await fetch(`${UPSTREAM}/chat/completions`, {
              method: 'POST', signal: ctl.signal, redirect: 'error',
              headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
              body: JSON.stringify(sanitize(body)),
            });
          } catch (e) { if (ctl.signal.aborted || last) throw e; continue; }
          if (up.status >= 400) {
            const text = await up.text();
            if (!retryable(up.status) || exhausted(text) || last) { console.log(`upstream ${up.status} ${tries[i]} final: ${upstreamReason(text)}`); return fail(up.status, text); }
            console.log(`upstream ${up.status} ${tries[i]} retry: ${upstreamReason(text)}`);
            continue;
          }
          const eventStream = stream && up.body && (up.headers.get('content-type') || '').includes('text/event-stream');
          if (!eventStream) {
            // a 200 whose JSON body is an error is a failed attempt, not a reply
            const text = await up.text();
            const reason = bodyError(text);
            if (reason && !last) { console.log(`upstream 200-error ${tries[i]} retry: ${reason}`); continue; }
            if (reason) { console.log(`upstream 200-error ${tries[i]} final: ${reason}`); return fail(502, text); }
            stop();
            if (!opened) res.writeHead(up.status, { 'content-type': up.headers.get('content-type') || 'application/json', 'cache-control': 'no-store', 'x-bos-free-remaining': String(remaining(id).install) });
            return res.end(text);
          }
          // Hold the stream until the model really answers, so an error sent before the reply can be retried cleanly.
          open();
          const reader = up.body.getReader(); const decoder = new TextDecoder();
          const held = []; let size = 0; let pending = ''; let verdict = null; const since = Date.now();
          while (!verdict) {
            const { done, value } = await reader.read();
            if (done) { verdict = 'end'; break; }
            held.push(value); size += value.length; pending += decoder.decode(value, { stream: true });
            let nl;
            while (!verdict && (nl = pending.indexOf('\n')) >= 0) { verdict = streamLine(pending.slice(0, nl).trim()); pending = pending.slice(nl + 1); }
            if (!verdict && (size > HOLD_BYTES || Date.now() - since > HOLD_MS)) verdict = 'answer';
          }
          if (verdict === 'error' && !last) { await reader.cancel().catch(() => {}); console.log(`upstream stream-error ${tries[i]} retry`); continue; }
          if (verdict === 'error') console.log(`upstream stream-error ${tries[i]} final`);
          if (verdict === 'error' || (verdict === 'end' && !size)) refund();
          stop();
          for (const chunk of held) res.write(chunk);
          for (;;) {
            const { done, value } = await reader.read(); if (done) break;
            if (res.destroyed) { await reader.cancel().catch(() => {}); break; }
            if (!res.write(value)) await new Promise((resolve) => { res.once('drain', resolve); res.once('close', resolve); });
          }
          return res.end();
        }
      } catch (e) { refund(); stop(); if (opened) { res.write(`data: ${JSON.stringify({ error: { code: 502, message: 'BOS Free upstream unavailable' } })}\n\n`); return res.end(); } throw e; }
      return fail(502, '');
    }
    return send(res, 404, { error: { message: 'Not found' } });
  } catch (e) {
    if (res.headersSent) return res.end();
    return send(res, e.status || 502, { error: { message: e.status ? e.message : 'BOS Free upstream unavailable' } });
  }
});

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) server.listen(PORT, '127.0.0.1', () => console.log(`bos-free on ${PORT}`));
