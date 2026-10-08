import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { createServer as httpServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const pause = ms => new Promise(r => setTimeout(r, ms));
export async function until(fn, label, ms = 6000) {
  const deadline = Date.now() + ms;
  do { const value = await fn(); if (value) return value; await pause(10); } while (Date.now() < deadline);
  throw new Error('acceptance deadline: ' + label);
}

/** Only an owned local D1 issuer and throwaway PostgreSQL. No inherited auth. */
export async function ownedFixture(server, { evidence, record = () => {} } = {}) {
  const cp = resolve(server, 'cloudflare/control-plane');
  const issuerLog = evidence ? resolve(evidence, 'issuer-worker.private.log') : null;
  if (issuerLog) writeFileSync(issuerLog, '', { flag: 'wx', mode: 0o600 });
  const wrangler = resolve(cp, 'node_modules/wrangler/bin/wrangler.js');
  const dir = await mkdtemp(resolve(tmpdir(), 'bos-slice34-issuer-'));
  const net = createServer();
  await new Promise(r => net.listen(0, '127.0.0.1', r));
  const port = net.address().port;
  await new Promise(r => net.close(r));
  const upstream = 'http://127.0.0.1:' + port;
  const issuerFault = { outage: false, stall_ms: 0, stall_bearer: null, drop_me_response_bearer: null };
  const proxy = httpServer(async (req, res) => {
    const started = performance.now();
    const info = { type: 'issuer_proxy', method: req.method, path: req.url.split('?')[0] };
    try {
      if (req.url === '/v1/me' && issuerFault.outage) { record({ ...info, status: 503, injected_outage: true }); res.writeHead(503); res.end('{}'); return; }
      const bearer = req.headers.authorization?.replace(/^Bearer /, '');
      if (req.url === '/v1/me' && issuerFault.stall_ms && (!issuerFault.stall_bearer || issuerFault.stall_bearer === bearer)) {
        const ms = issuerFault.stall_ms;
        record({ ...info, injected_stall_ms: ms, bearer_sha256: createHash('sha256').update(bearer ?? '').digest('hex') });
        await pause(ms);
        record({ ...info, stall_elapsed_ms: performance.now() - started, client_disconnected: res.destroyed });
      }
      if (res.destroyed) return;
      const chunks = []; for await (const b of req) chunks.push(b);
      const headers = { ...req.headers }; delete headers.host; delete headers.connection; delete headers['content-length'];
      const response = await fetch(upstream + req.url, { method: req.method, headers,
        ...(!['GET', 'HEAD'].includes(req.method) ? { body: Buffer.concat(chunks) } : {}), redirect: 'manual' });
      if (req.url === '/v1/me' && bearer && issuerFault.drop_me_response_bearer === bearer) {
        issuerFault.drop_me_response_bearer = null;
        await response.arrayBuffer();
        record({ ...info, upstream_status: response.status, injected_response_loss: true,
          bearer_sha256: createHash('sha256').update(bearer).digest('hex'), duration_ms: performance.now() - started });
        res.destroy(); return;
      }
      record({ ...info, upstream_status: response.status, duration_ms: performance.now() - started,
        ...(req.url === '/v1/me' && bearer ? { bearer_sha256: createHash('sha256').update(bearer).digest('hex') } : {}) });
      const outHeaders = Object.fromEntries(response.headers); delete outHeaders['content-encoding']; delete outHeaders['content-length'];
      if (response.headers.getSetCookie().length) outHeaders['set-cookie'] = response.headers.getSetCookie();
      res.writeHead(response.status, outHeaders); res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) { record({ ...info, status: 503, transport_error: error.name, duration_ms: performance.now() - started }); if (!res.destroyed) { res.writeHead(503); res.end('{}'); } }
  });
  await new Promise(r => proxy.listen(0, '127.0.0.1', r));
  const issuer = 'http://127.0.0.1:' + proxy.address().port;
  const children = new Set();
  let fixture;
  let stopping;
  const launch = args => {
    const p = spawn(process.execPath, [wrangler, ...args], { cwd: cp,
      env: { PATH: process.env.PATH, HOME: dir, TMPDIR: tmpdir(), LC_ALL: 'en_US.UTF-8', WRANGLER_SEND_METRICS: 'false' },
      stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(p); p.logs = '';
    const retain = v => { p.logs += v; if (issuerLog) appendFileSync(issuerLog, v); };
    p.stdout.on('data', retain); p.stderr.on('data', retain);
    p.done = new Promise((r, j) => { p.once('error', j); p.once('exit', code => { children.delete(p); r(code); }); });
    return p;
  };
  const interrupted = () => { void stop().then(() => process.exit(130)); };
  const stop = () => stopping ??= (async () => {
    process.off('SIGINT', interrupted); process.off('SIGTERM', interrupted);
    if (fixture) { await fixture.stop(); fixture = undefined; }
    for (const p of [...children]) { p.kill('SIGTERM'); await p.done; }
    proxy.closeAllConnections(); await new Promise(r => proxy.close(r));
    await rm(dir, { recursive: true, force: true });
  })();
  process.once('SIGINT', interrupted); process.once('SIGTERM', interrupted);
  try {
    const names = ['0001_better_auth_1_7_1.sql', '0002_installations.sql', '0003_otp_recipient_rate_limits.sql', '0004_managed_companion_endpoints.sql', '0005_endpoint_cleanup_backoff.sql'];
    await writeFile(dir + '/migrations.sql', (await Promise.all(names.map(n => readFile(cp + '/migrations/' + n, 'utf8')))).join('\n'), { mode: 0o600 });
    const migration = launch(['d1', 'execute', 'bos-slice2-local', '--local', '--config', 'wrangler.local.jsonc', '--persist-to', dir + '/d1', '--file', dir + '/migrations.sql']);
    assert.equal(await migration.done, 0, 'owned local D1 migration failed');
    const worker = launch(['dev', '--local', '--config', 'wrangler.local.jsonc', '--persist-to', dir + '/d1', '--ip', '127.0.0.1', '--port', String(port), '--var', 'BETTER_AUTH_URL:' + issuer, '--var', 'ALLOWED_ORIGINS:http://127.0.0.1:5199']);
    await until(async () => {
      assert.equal(worker.exitCode, null, 'owned local issuer exited');
      try { return (await fetch(upstream + '/healthz', { signal: AbortSignal.timeout(500) })).ok; } catch { return false; }
    }, 'real issuer startup', 35000);
    const { realFixture } = await import(pathToFileURL(server + '/services/cloud/fixture.ts').href);
    fixture = await realFixture(issuer, true);
    return { ...fixture, issuer_url: issuer, issuer_fault: issuerFault, owned_issuer_pid: worker.pid, owned_issuer_directory: dir, stop };
  } catch (e) { await stop(); throw e; }
}
