/**
 * Private self-host identity issuer. Same Better Auth 1.7.1 contract as the hosted
 * control plane (cloudflare/control-plane/src/auth.ts): email OTP (8 digits, 10 min,
 * 5 attempts, hashed, rotate), signed bearer (`set-auth-token`), database rate limits,
 * fresh `/v1/me` with cookie cache and refresh disabled. Storage is the operator's own
 * PostgreSQL. It never talks to the hosted issuer.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { betterAuth } from 'better-auth';
import { bearer, emailOTP } from 'better-auth/plugins';
import { getMigrations } from 'better-auth/db/migration';
import pg from 'pg';
import * as Sentry from '@sentry/node';

const HOSTED = /(^|\.)openmausbot\.com$/i;
const MAX_BODY = 16 * 1024;

export type IssuerConfig = {
  publicURL: string;
  databaseURL: string;
  secret: string;
  allowedOrigins: string[];
  allowedEmails: Set<string>;
  allowedDomains: Set<string>;
  delivery: 'log' | 'smtp';
  smtpURL?: string;
  emailFrom?: string;
  port: number;
  host: string;
};

function exactOrigin(value: string, label: string, httpsOnly = true) {
  const u = new URL(value);
  if ((httpsOnly && u.protocol !== 'https:') || u.username || u.password || u.pathname !== '/' || u.search || u.hash)
    throw new Error(label + ' must be an exact https:// origin');
  return u.origin;
}
const list = (v: string | undefined) => (v ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

export function readIssuerConfig(env: NodeJS.ProcessEnv): IssuerConfig {
  const publicURL = exactOrigin(env.ISSUER_PUBLIC_URL ?? '', 'ISSUER_PUBLIC_URL');
  if (HOSTED.test(new URL(publicURL).hostname)) throw new Error('private issuer cannot use the hosted issuer domain');
  const databaseURL = env.ISSUER_DATABASE_URL;
  if (!databaseURL) throw new Error('ISSUER_DATABASE_URL required');
  const secret = env.BETTER_AUTH_SECRET ?? '';
  if (secret.length < 32) throw new Error('BETTER_AUTH_SECRET must contain at least 32 characters');
  const delivery = (env.ISSUER_OTP_DELIVERY ?? 'log') as 'log' | 'smtp';
  if (!['log', 'smtp'].includes(delivery)) throw new Error('ISSUER_OTP_DELIVERY must be log or smtp');
  if (delivery === 'smtp' && (!env.ISSUER_SMTP_URL || !env.ISSUER_EMAIL_FROM)) throw new Error('smtp delivery needs ISSUER_SMTP_URL and ISSUER_EMAIL_FROM');
  const port = Number(env.ISSUER_PORT ?? '8787');
  return {
    publicURL, databaseURL, secret, delivery,
    allowedOrigins: list(env.ISSUER_ALLOWED_ORIGINS).map(v => exactOrigin(v, 'ISSUER_ALLOWED_ORIGINS', false)),
    allowedEmails: new Set(list(env.ISSUER_ALLOWED_EMAILS)),
    allowedDomains: new Set(list(env.ISSUER_ALLOWED_EMAIL_DOMAINS)),
    smtpURL: env.ISSUER_SMTP_URL || undefined, emailFrom: env.ISSUER_EMAIL_FROM || undefined,
    port, host: env.ISSUER_HOST ?? '0.0.0.0',
  };
}

export function emailAllowed(config: Pick<IssuerConfig, 'allowedEmails' | 'allowedDomains'>, email: unknown) {
  if (typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return false;
  if (!config.allowedEmails.size && !config.allowedDomains.size) return true;
  const e = email.toLowerCase();
  return config.allowedEmails.has(e) || config.allowedDomains.has(e.slice(e.lastIndexOf('@') + 1));
}

type OTPInput = { email: string; otp: string; type: string };
async function deliver(config: IssuerConfig, input: OTPInput) {
  if (config.delivery === 'log') {
    // Operator relays the code (docker compose logs issuer). Never enable on a shared log sink.
    console.log(JSON.stringify({ otp_delivery: 'log', email: input.email, type: input.type, otp: input.otp }));
    return;
  }
  const nodemailer = await import('nodemailer');
  const transport = nodemailer.createTransport(config.smtpURL!);
  await transport.sendMail({
    from: config.emailFrom, to: input.email, subject: 'Your BOS sign-in code',
    text: `Your BOS sign-in code is ${input.otp}\n\nIt expires in 10 minutes. If you did not ask for it, ignore this email.`,
  });
}

function authOptions(config: IssuerConfig, pool: pg.Pool) {
  return {
    appName: 'BOS self-host',
    baseURL: config.publicURL,
    basePath: '/api/auth',
    secret: config.secret,
    database: pool,
    trustedOrigins: [config.publicURL, ...config.allowedOrigins],
    logger: { disabled: true },
    rateLimit: {
      enabled: true, storage: 'database' as const, window: 60, max: 60,
      customRules: { '/email-otp/send-verification-otp': { window: 60, max: 5 }, '/sign-in/email-otp': { window: 60, max: 10 } },
    },
    advanced: {
      useSecureCookies: true,
      // Caddy is the only ingress and overwrites X-Forwarded-For from untrusted clients.
      ipAddress: { ipAddressHeaders: ['x-forwarded-for'] },
      database: { generateId: 'uuid' as const },
    },
    plugins: [
      emailOTP({
        otpLength: 8, expiresIn: 10 * 60, allowedAttempts: 5, storeOTP: 'hashed', resendStrategy: 'rotate',
        disableSignUp: false, rateLimit: { window: 60, max: 5 },
        async sendVerificationOTP(input) {
          if (!emailAllowed(config, input.email)) throw new Error('email not allowed');
          await deliver(config, input);
        },
      }),
      bearer({ requireSignature: true }),
    ],
  };
}

const ERROR_CODES = new Map([
  ['INVALID_EMAIL', 'invalid_email'], ['INVALID_OTP', 'invalid_otp'], ['OTP_EXPIRED', 'otp_expired'],
  ['TOO_MANY_ATTEMPTS', 'rate_limited'], ['USER_NOT_FOUND', 'invalid_otp'], ['VALIDATION_ERROR', 'invalid_request'],
]);
function statusCode(status: number) {
  return ({ 400: 'invalid_request', 401: 'unauthorized', 403: 'forbidden', 404: 'not_found', 405: 'method_not_allowed', 409: 'conflict', 413: 'request_too_large', 415: 'unsupported_media_type', 422: 'invalid_request', 429: 'rate_limited' } as Record<number, string>)[status] ?? 'request_failed';
}
const jsonResponse = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

export async function startIssuer(config: IssuerConfig) {
  const pool = new pg.Pool({ connectionString: config.databaseURL, max: 10, connectionTimeoutMillis: 3000 });
  pool.on('error', () => {});
  const options = authOptions(config, pool);
  const { runMigrations } = await getMigrations(options as any);
  await runMigrations();
  const auth = betterAuth(options);
  const origins = new Set([config.publicURL, ...config.allowedOrigins]);

  async function route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/healthz') {
      await pool.query('SELECT 1');
      return jsonResponse({ ok: true, service: 'bos-selfhost-issuer', issuer: config.publicURL });
    }
    const origin = request.headers.get('origin');
    if (origin && !origins.has(origin)) return jsonResponse({ error: 'origin_not_allowed' }, 403);
    if (url.pathname.startsWith('/api/auth/')) {
      if (request.method === 'POST' && ['/api/auth/email-otp/send-verification-otp', '/api/auth/sign-in/email-otp'].includes(url.pathname)) {
        let body: any;
        try { body = await request.clone().json(); } catch { return jsonResponse({ error: 'invalid_request' }, 400); }
        if (!emailAllowed(config, body?.email)) return jsonResponse({ error: 'email_not_allowed' }, 403);
      }
      const response = await auth.handler(request);
      if (response.status >= 500) return jsonResponse({ error: 'internal_error' }, 500);
      if (response.status < 400) return response;
      const payload: any = await response.json().catch(() => null);
      return jsonResponse({ error: ERROR_CODES.get(payload?.code) ?? statusCode(response.status) }, response.status);
    }
    if (request.method === 'GET' && url.pathname === '/v1/me') {
      const authorization = request.headers.get('authorization');
      const match = authorization?.match(/^Bearer\s+([^\s]+)$/i);
      if (authorization && !match) return jsonResponse({ error: 'unauthorized' }, 401);
      if (!match && !request.headers.has('cookie')) return jsonResponse({ error: 'unauthorized' }, 401);
      const headers = match ? new Headers({ authorization: `Bearer ${match[1]}` }) : new Headers({ cookie: request.headers.get('cookie')! });
      // Always the current DB session row: a cached cookie cannot restore a revoked session.
      const session = await auth.api.getSession({ headers, query: { disableCookieCache: true, disableRefresh: true } });
      if (!session) return jsonResponse({ error: 'unauthorized' }, 401);
      return jsonResponse({ user: { id: session.user.id, email: session.user.email, name: session.user.name, emailVerified: session.user.emailVerified } });
    }
    return jsonResponse({ error: 'not_found' }, 404);
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY) { res.writeHead(413, { 'content-type': 'application/json' }); res.end('{"error":"request_too_large"}'); return; }
        chunks.push(chunk);
      }
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
      // Public origin, not the internal listener: cookies, CSRF and callbacks bind to it.
      const url = new URL(req.url ?? '/', config.publicURL);
      const body = ['GET', 'HEAD'].includes(req.method ?? 'GET') ? undefined : Buffer.concat(chunks);
      const response = await route(new Request(url, { method: req.method, headers, body }));
      const out: Record<string, string | string[]> = {};
      response.headers.forEach((v, k) => { if (k !== 'set-cookie') out[k] = v; });
      const cookies = response.headers.getSetCookie();
      if (cookies.length) out['set-cookie'] = cookies;
      out['x-content-type-options'] = 'nosniff';
      if (origin(req) && origins.has(origin(req)!)) {
        out['access-control-allow-origin'] = origin(req)!;
        out['access-control-allow-credentials'] = 'true';
        out['access-control-expose-headers'] = 'set-auth-token';
        out['vary'] = 'Origin';
      }
      res.writeHead(response.status, out);
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (e) {
      Sentry.captureException(e);
      console.error(JSON.stringify({ message: 'request failed', error: (e as Error).message }));
      if (!res.headersSent) { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":"internal_error"}'); }
    }
  });
  await new Promise<void>((r, j) => { server.once('error', j); server.listen(config.port, config.host, r); });
  return {
    server, url: `http://127.0.0.1:${(server.address() as any).port}`,
    async close() { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await pool.end(); },
  };
}
const origin = (req: IncomingMessage) => typeof req.headers.origin === 'string' ? req.headers.origin : undefined;

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const config = readIssuerConfig(process.env);
  const app = await startIssuer(config);
  console.log(JSON.stringify({ started: 'issuer', issuer: config.publicURL, delivery: config.delivery, port: config.port,
    signup: config.allowedEmails.size || config.allowedDomains.size ? 'allowlist' : 'open' }));
  let closing = false;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { if (closing) return; closing = true; void app.close().then(() => process.exit(0)); });
}
