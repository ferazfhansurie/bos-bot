/**
 * Private self-host entrypoint (deploy/selfhost). Same room service, worker and
 * migrations as the local slices; configuration comes only from the operator's env.
 *
 *   node --experimental-strip-types selfhost.ts migrate   # one-shot, owner role, ledgered
 *   node --experimental-strip-types selfhost.ts room      # HTTP/WS, no in-process worker
 *   node --experimental-strip-types selfhost.ts worker    # SQL queue worker only
 *
 * No fixture, stub issuer or test route is in this module graph.
 */
import pg from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Database } from './db.ts';
import { CloudService } from './service.ts';
import { ControlPlaneIssuer } from './identity.ts';
import { startCloud } from './http.ts';
import { LocalObjects } from './objects.ts';

const HOSTED_ISSUER = /(^|\.)openmausbot\.com$/i;

export type SelfHostConfig = {
  databaseURL: string;
  serviceURL: string;
  issuerURL: string;
  issuerFetchURL?: string;
  key: Buffer;
  allowedOrigins: string[];
  objectStorePath?: string;
  listenHost: string;
  listenPort: number;
};

function httpsOrigin(value: string|undefined, label: string) {
  if (!value) throw new Error(label+' required');
  const u = new URL(value);
  if (u.protocol!=='https:' || u.username || u.password || u.pathname!=='/' || u.search || u.hash)
    throw new Error(label+' must be an exact https:// origin');
  return u.origin;
}

export function readSelfHostConfig(env: NodeJS.ProcessEnv): SelfHostConfig {
  const serviceURL = httpsOrigin(env.CLOUD_SERVICE_URL,'CLOUD_SERVICE_URL');
  const issuerURL = httpsOrigin(env.CLOUD_ISSUER_URL,'CLOUD_ISSUER_URL');
  if (HOSTED_ISSUER.test(new URL(issuerURL).hostname))
    throw new Error('self-host must use its own private issuer, never the hosted issuer');
  const databaseURL = env.CLOUD_DATABASE_URL;
  if (!databaseURL) throw new Error('CLOUD_DATABASE_URL required');
  if (new URL(databaseURL).username!=='cloud_app') throw new Error('CLOUD_DATABASE_URL must use the non-owner cloud_app role');
  const rawKey = env.CLOUD_SERVICE_KEY ?? '';
  const key = Buffer.from(rawKey,'base64');
  if (key.length < 32) throw new Error('CLOUD_SERVICE_KEY must be base64 of at least 32 random bytes');
  const port = Number(env.CLOUD_LISTEN_PORT ?? '8790');
  if (!Number.isInteger(port) || port<1 || port>65535) throw new Error('CLOUD_LISTEN_PORT invalid');
  const allowedOrigins = (env.CLOUD_ALLOWED_ORIGINS ?? '').split(',').map(v=>v.trim()).filter(Boolean).map(v=>new URL(v).origin);
  return {databaseURL,serviceURL,issuerURL,issuerFetchURL:env.CLOUD_ISSUER_INTERNAL_URL||undefined,key,
    allowedOrigins,objectStorePath:env.CLOUD_OBJECT_STORE_PATH||undefined,listenHost:env.CLOUD_LISTEN_HOST ?? '0.0.0.0',listenPort:port};
}

function service(config: SelfHostConfig) {
  const s = new CloudService(new Database(config.databaseURL,{selfHost:true}),
    new ControlPlaneIssuer(config.issuerURL,config.serviceURL,config.issuerFetchURL),config.serviceURL,config.key);
  // No production scanner is wired: uploads stay quarantined (fail closed), never ready.
  if (config.objectStorePath) s.attachments.store = new LocalObjects(config.objectStorePath);
  return s;
}

export async function startRoom(config: SelfHostConfig) {
  return startCloud(service(config),config.listenPort,config.listenHost,undefined,false,
    new Set([config.serviceURL,...config.allowedOrigins]),{selfHost:true});
}

export function startWorker(config: SelfHostConfig, intervalMs = 200) {
  const s = service(config);
  let busy = false, stopped = false, failures = 0;
  const timer = setInterval(async () => {
    if (busy || stopped) return;
    busy = true;
    try { await s.tickWorker(); if (failures) console.log(JSON.stringify({worker:'recovered',after_failures:failures})); failures = 0; }
    catch (e) { if (failures++ % 50 === 0) console.error(JSON.stringify({worker:'tick_failed',error:(e as Error).message})); }
    finally { busy = false; }
  }, intervalMs);
  return {async close(){ stopped = true; clearInterval(timer); while(busy) await new Promise(r=>setTimeout(r,20)); await s.db.close(); }};
}

/** Applies each migration once, in order, recorded in a ledger. Safe to rerun on upgrade. */
export async function migrate(migrationURL: string, appPassword: string) {
  if (!appPassword || appPassword.length < 16) throw new Error('CLOUD_APP_PASSWORD must be at least 16 characters');
  const c = new pg.Client({connectionString: migrationURL});
  await c.connect();
  const applied: string[] = [];
  try {
    await c.query('SELECT pg_advisory_lock(424242005)');
    await c.query('CREATE TABLE IF NOT EXISTS public.bos_selfhost_migrations(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await c.query('SELECT name FROM public.bos_selfhost_migrations')).rows.map(r=>r.name));
    const dir = new URL('./migrations/',import.meta.url);
    for (const name of (await readdir(dir)).filter(v=>v.endsWith('.sql')).sort()) {
      if (done.has(name)) continue;
      await c.query('BEGIN');
      try {
        // Files carry their own BEGIN/COMMIT for the local launchers; strip them so the
        // migration and its ledger row commit atomically (a crash never half-applies).
        const sql = (await readFile(new URL(name,dir),'utf8'))
          .replace(/^((?:\s*--[^\n]*\n)*)\s*BEGIN;/i,'$1').replace(/COMMIT;\s*$/i,'');
        await c.query(sql);
        await c.query('INSERT INTO public.bos_selfhost_migrations(name) VALUES($1)',[name]);
        await c.query('COMMIT');
        applied.push(name);
      } catch (e) { await c.query('ROLLBACK'); throw e; }
    }
    // cloud_app is created by 001 without a password; give it the operator's password.
    await c.query(`ALTER ROLE cloud_app PASSWORD ${c.escapeLiteral(appPassword)}`);
    // The self-host bootstrap revokes PUBLIC connect on the room database.
    const database = (await c.query('SELECT current_database() AS name')).rows[0].name;
    await c.query(`GRANT CONNECT ON DATABASE ${c.escapeIdentifier(database)} TO cloud_app`);
    await c.query('REVOKE ALL ON public.bos_selfhost_migrations FROM PUBLIC');
  } finally {
    try { await c.query('SELECT pg_advisory_unlock(424242005)'); } catch {}
    await c.end();
  }
  return applied;
}

if (process.argv[1] && resolve(process.argv[1])===new URL(import.meta.url).pathname) {
  const mode = process.argv[2];
  if (mode==='migrate') {
    const url = process.env.CLOUD_MIGRATION_URL;
    if (!url) throw new Error('CLOUD_MIGRATION_URL required');
    const applied = await migrate(url,process.env.CLOUD_APP_PASSWORD ?? '');
    console.log(JSON.stringify({migrated:true,applied}));
  } else if (mode==='room' || mode==='worker') {
    const config = readSelfHostConfig(process.env);
    const app = mode==='room' ? await startRoom(config) : startWorker(config);
    console.log(JSON.stringify({started:mode,service:config.serviceURL,issuer:config.issuerURL,port:mode==='room'?config.listenPort:undefined}));
    let closing = false;
    for (const signal of ['SIGTERM','SIGINT'] as const) process.on(signal,()=>{ if(closing)return; closing=true; void app.close().then(()=>process.exit(0)); });
  } else {
    console.error('usage: selfhost.ts migrate|room|worker');
    process.exit(2);
  }
}
