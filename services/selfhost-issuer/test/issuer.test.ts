import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import pg from 'pg';
import { readIssuerConfig, startIssuer, emailAllowed } from '../server.ts';

async function freePort() {
  const s = createServer();
  await new Promise<void>(r => s.listen(0, '127.0.0.1', r));
  const p = (s.address() as any).port;
  await new Promise<void>(r => s.close(() => r()));
  return p;
}
async function cluster() {
  const dir = await mkdtemp(tmpdir() + '/bos-issuer-test-');
  const port = await freePort();
  const env = { ...process.env, LC_ALL: 'C' };
  await new Promise<void>((r, j) => spawn('/opt/homebrew/bin/initdb', ['-D', dir + '/pg', '-U', 'owner', '--auth=trust', '--no-locale'], { stdio: 'ignore', env }).on('exit', c => c === 0 ? r() : j(new Error('initdb'))));
  const p = spawn('/opt/homebrew/bin/postgres', ['-D', dir + '/pg', '-h', '127.0.0.1', '-p', String(port), '-k', '', '-c', 'shared_buffers=16MB'], { stdio: 'ignore', env });
  for (let n = 0; ; n++) {
    const c = new pg.Client({ connectionString: `postgres://owner@127.0.0.1:${port}/postgres`, connectionTimeoutMillis: 200 });
    try { await c.connect(); await c.query('CREATE DATABASE bos_issuer'); break; }
    catch (e) { if (n > 60) throw e; await new Promise(r => setTimeout(r, 100)); }
    finally { await c.end().catch(() => {}); }
  }
  return { url: `postgres://owner@127.0.0.1:${port}/bos_issuer`, async stop() {
    const done = new Promise<void>(r => p.exitCode !== null ? r() : p.once('exit', () => r()));
    p.kill('SIGTERM'); await done; await rm(dir, { recursive: true, force: true });
  } };
}
const env = (over: Record<string, string> = {}) => ({ ISSUER_PUBLIC_URL: 'https://bos.example.test', ISSUER_DATABASE_URL: 'postgres://x@db/issuer', BETTER_AUTH_SECRET: 'x'.repeat(40), ...over }) as NodeJS.ProcessEnv;

test('config refuses the hosted issuer, plain http and short secrets; allowlist', () => {
  assert.equal(readIssuerConfig(env()).delivery, 'log');
  assert.throws(() => readIssuerConfig(env({ ISSUER_PUBLIC_URL: 'https://accounts.openmausbot.com' })), /hosted/);
  assert.throws(() => readIssuerConfig(env({ ISSUER_PUBLIC_URL: 'http://bos.example.test' })), /https/);
  assert.throws(() => readIssuerConfig(env({ BETTER_AUTH_SECRET: 'short' })), /32/);
  assert.throws(() => readIssuerConfig(env({ ISSUER_OTP_DELIVERY: 'smtp' })), /SMTP/);
  const c = readIssuerConfig(env({ ISSUER_ALLOWED_EMAIL_DOMAINS: 'partner.example', ISSUER_ALLOWED_EMAILS: 'firaz@else.example' }));
  assert.ok(emailAllowed(c, 'a@partner.example'));
  assert.ok(emailAllowed(c, 'FIRAZ@else.example'));
  assert.ok(!emailAllowed(c, 'x@evil.example'));
  assert.ok(emailAllowed(readIssuerConfig(env()), 'anyone@x.example'));
});

test('email OTP sign-in issues a signed bearer that /v1/me validates fresh; sign-out revokes it', async () => {
  const db = await cluster();
  const codes = new Map<string, string>();
  const log = console.log;
  console.log = (...args: any[]) => { try { const v = JSON.parse(args[0]); if (v.otp_delivery) { codes.set(v.email, v.otp); return; } } catch {} log(...args); };
  const port = await freePort();
  const app = await startIssuer(readIssuerConfig(env({ ISSUER_DATABASE_URL: db.url, ISSUER_PORT: String(port), ISSUER_HOST: '127.0.0.1', ISSUER_ALLOWED_EMAIL_DOMAINS: 'pilot.example' })));
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(app.url + path, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://bos.example.test', ...headers }, body: JSON.stringify(body) });
  try {
    assert.equal((await fetch(app.url + '/healthz')).status, 200);
    assert.equal((await post('/api/auth/email-otp/send-verification-otp', { email: 'x@evil.example', type: 'sign-in' })).status, 403);
    assert.equal((await post('/api/auth/email-otp/send-verification-otp', { email: 'alice@pilot.example', type: 'sign-in' })).status, 200);
    const otp = codes.get('alice@pilot.example')!;
    assert.match(otp, /^\d{8}$/);
    const bad = await post('/api/auth/sign-in/email-otp', { email: 'alice@pilot.example', otp: '00000000' });
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { error: 'invalid_otp' });
    const signed = await post('/api/auth/sign-in/email-otp', { email: 'alice@pilot.example', otp });
    assert.equal(signed.status, 200);
    const bearer = signed.headers.get('set-auth-token')!;
    assert.ok(bearer && bearer.includes('.'), 'signed bearer header');
    assert.ok(signed.headers.getSetCookie().some(c => c.startsWith('__Secure-')), 'secure cookie');
    const me = await fetch(app.url + '/v1/me', { headers: { authorization: 'Bearer ' + bearer } });
    assert.equal(me.status, 200);
    const user = (await me.json()).user;
    assert.equal(user.email, 'alice@pilot.example');
    assert.equal((await fetch(app.url + '/v1/me', { headers: { authorization: 'Bearer ' + bearer.split('.')[0] + '.forged' } })).status, 401);
    assert.equal((await fetch(app.url + '/v1/me', { headers: { origin: 'https://evil.example', authorization: 'Bearer ' + bearer } })).status, 403);
    assert.equal((await post('/api/auth/sign-out', {}, { authorization: 'Bearer ' + bearer })).status, 200);
    assert.equal((await fetch(app.url + '/v1/me', { headers: { authorization: 'Bearer ' + bearer } })).status, 401);
    // Same subject on the next sign-in.
    await post('/api/auth/email-otp/send-verification-otp', { email: 'alice@pilot.example', type: 'sign-in' });
    const again = await post('/api/auth/sign-in/email-otp', { email: 'alice@pilot.example', otp: codes.get('alice@pilot.example')! });
    const me2 = await fetch(app.url + '/v1/me', { headers: { authorization: 'Bearer ' + again.headers.get('set-auth-token') } });
    assert.equal((await me2.json()).user.id, user.id);
  } finally {
    console.log = log;
    await app.close(); await db.stop();
  }
});
