// BOS Free: hosted zero-price OpenRouter relay. Holds the owner key server-side;
// installs get per-install tokens with daily caps. Never forwards paid models.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const PORT = Number(process.env.PORT || 3370);
const KEY = process.env.OPENROUTER_API_KEY || '';
const DATA = process.env.BOS_FREE_DATA || path.join(process.cwd(), 'data.json');
const PER_INSTALL = Number(process.env.PER_INSTALL_DAILY || 20);
const GLOBAL = Number(process.env.GLOBAL_DAILY || 45);
const REG_PER_IP = Number(process.env.REGISTER_PER_IP_DAILY || 2);
const CHAT_PER_IP = Number(process.env.CHAT_PER_IP_DAILY || 25);
const UPSTREAM = process.env.UPSTREAM || 'https://openrouter.ai/api/v1';
const MAX_BODY = 4 * 1024 * 1024;
const MAX_TOKENS = 4096;
const ATTEMPTS = Number(process.env.UPSTREAM_ATTEMPTS || 4);
const COOLDOWN_MS = Number(process.env.MODEL_COOLDOWN_MS || 60_000);
if (!KEY) { console.error('OPENROUTER_API_KEY missing'); process.exit(1); }

const today = () => new Date().toISOString().slice(0, 10);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
let db = { installs: {}, day: today(), global: 0, usage: {}, reg: {}, ipUsage: {} };
try { db = { ...db, ...JSON.parse(fs.readFileSync(DATA, 'utf8')) }; } catch {}
const save = () => { const t = DATA + '.tmp'; fs.writeFileSync(t, JSON.stringify(db), { mode: 0o600 }); fs.renameSync(t, DATA); };
const roll = () => { if (db.day !== today()) { db.day = today(); db.global = 0; db.usage = {}; db.reg = {}; db.ipUsage = {}; save(); } };

export const isFreeId = (id) => typeof id === 'string' && (id === 'openrouter/free' || /^[a-zA-Z0-9_./-]+:free$/.test(id));
const zero = (v) => v !== undefined && v !== null && v !== '' && Number(v) === 0;
export const isFreeToolModel = (m) => !!m && isFreeId(m.id) && m.pricing && Object.values(m.pricing).every(zero)
  && Array.isArray(m.supported_parameters) && m.supported_parameters.includes('tools');

let catalog = { at: 0, data: [] };
async function freeCatalog() {
  if (Date.now() - catalog.at < 10 * 60_000 && catalog.data.length) return catalog.data;
  const r = await fetch(`${UPSTREAM}/models`, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('catalog');
  const j = await r.json();
  catalog = { at: Date.now(), data: (j.data || []).filter(isFreeToolModel) };
  return catalog.data;
}

// Shared free pools rate-limit individual models often. For the free router,
// a refused model cools down and the next verified free model is tried
// before any byte reaches the caller; every candidate is still :free.
const cooling = new Map();
const cool = (id) => cooling.set(id, Date.now() + COOLDOWN_MS);
const warm = (id) => !(cooling.get(id) > Date.now());
export function candidates(requested, models) {
  if (requested !== 'openrouter/free') return [requested];
  const rest = models.map((m) => m.id).filter((id) => id !== requested && warm(id));
  for (let i = rest.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [rest[i], rest[j]] = [rest[j], rest[i]]; }
  return [requested, ...rest].slice(0, Math.max(1, ATTEMPTS));
}
const retryable = (status) => status === 429 || status === 502 || status === 503;
const limitedModel = (text) => /([a-zA-Z0-9_./-]+:free) is temporarily rate-limited/.exec(text)?.[1];

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

// Only these request fields reach OpenRouter; plugins/models/route could incur cost.
const ALLOWED = ['model', 'messages', 'stream', 'tools', 'tool_choice', 'temperature', 'top_p', 'stop', 'max_tokens', 'response_format', 'reasoning', 'stream_options', 'parallel_tool_calls', 'seed'];
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
  out.max_tokens = Math.min(Number(out.max_tokens) || MAX_TOKENS, MAX_TOKENS);
  out.provider = { allow_fallbacks: false, require_parameters: true, max_price: { prompt: 0, completion: 0, request: 0, image: 0 } };
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
    if (req.method === 'GET' && p === '/api/v1/models') return send(res, 200, { data: await freeCatalog() });
    if (req.method === 'POST' && p === '/api/v1/chat/completions') {
      const body = await readJson(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) return send(res, 400, { error: { message: 'Invalid request' } });
      if (!validContent(body)) return send(res, 400, { error: { message: 'BOS Free supports text messages and function tools only' } });
      const models = await freeCatalog();
      if (!isFreeId(body.model) || !models.some((m) => m.id === body.model)) return send(res, 400, { error: { message: 'Only verified free models are available' } });
      if ((db.usage[id] || 0) >= PER_INSTALL) return send(res, 429, { error: { message: 'Daily BOS Free limit reached for this install' } }, { 'x-bos-free-remaining': '0' });
      const ip = sha(clientIp(req));
      if ((db.ipUsage[ip] || 0) >= CHAT_PER_IP) return send(res, 429, { error: { message: 'Daily BOS Free limit reached for this network' } }, { 'x-bos-free-remaining': '0' });
      if (db.global >= GLOBAL) return send(res, 429, { error: { message: 'BOS Free is at capacity today' } }, { 'x-bos-free-remaining': '0' });
      db.usage[id] = (db.usage[id] || 0) + 1; db.ipUsage[ip] = (db.ipUsage[ip] || 0) + 1; db.global += 1; save();
      const ctl = new AbortController(); res.on('close', () => { if (!res.writableFinished) ctl.abort(); });
      const tries = candidates(body.model, models);
      let up;
      for (let i = 0; i < tries.length; i++) {
        up = await fetch(`${UPSTREAM}/chat/completions`, {
          method: 'POST', signal: ctl.signal, redirect: 'error',
          headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json', 'HTTP-Referer': 'https://bos.aihlete.com', 'X-Title': 'BOS Free' },
          body: JSON.stringify(sanitize({ ...body, model: tries[i] })),
        });
        if (!retryable(up.status) || i === tries.length - 1) break;
        const text = await up.text().catch(() => '');
        cool(limitedModel(text) || tries[i]);
      }
      // Upstream refusals (rate limits, provider errors) don't spend the caller's allowance.
      if (up.status >= 400) { db.usage[id] = Math.max(0, db.usage[id] - 1); db.ipUsage[ip] = Math.max(0, db.ipUsage[ip] - 1); db.global = Math.max(0, db.global - 1); save(); }
      res.writeHead(up.status, { 'content-type': up.headers.get('content-type') || 'application/json', 'cache-control': 'no-store', 'x-bos-free-remaining': String(remaining(id).install) });
      if (!up.body) return res.end();
      const reader = up.body.getReader();
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        if (res.destroyed) { await reader.cancel().catch(() => {}); break; }
        if (!res.write(value)) await new Promise((resolve) => { res.once('drain', resolve); res.once('close', resolve); });
      }
      return res.end();
    }
    return send(res, 404, { error: { message: 'Not found' } });
  } catch (e) {
    if (res.headersSent) return res.end();
    return send(res, e.status || 502, { error: { message: e.status ? e.message : 'BOS Free upstream unavailable' } });
  }
});

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) server.listen(PORT, '127.0.0.1', () => console.log(`bos-free on ${PORT}`));
