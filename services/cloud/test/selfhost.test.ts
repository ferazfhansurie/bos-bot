import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { migrate, readSelfHostConfig, startRoom, startWorker } from '../selfhost.ts';

async function freePort() {
  const s = netServer();
  await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));
  const p = (s.address() as any).port;
  await new Promise<void>(r=>s.close(()=>r()));
  return p;
}
async function run(bin: string, args: string[]) {
  const p = spawn(bin,args,{stdio:['ignore','pipe','pipe']});
  let out=''; p.stdout.on('data',v=>out+=v); p.stderr.on('data',v=>out+=v);
  const code = await new Promise<number|null>((r,j)=>{p.on('error',j);p.on('exit',r);});
  if (code!==0) throw new Error(bin+': '+out);
}
/** Bare throwaway cluster: proves migrate() on an empty server, as in a fresh compose volume. */
async function cluster() {
  const dir = await mkdtemp(tmpdir()+'/bos-selfhost-test-');
  const port = await freePort();
  await run('/opt/homebrew/bin/initdb',['-D',dir+'/pg','-U','bos_owner','--auth=trust','--encoding=UTF8','--no-locale']);
  const p = spawn('/opt/homebrew/bin/postgres',['-D',dir+'/pg','-h','127.0.0.1','-p',String(port),'-k','','-c','max_connections=40','-c','shared_buffers=16MB'],{stdio:'ignore',env:{...process.env,LC_ALL:'C'}});
  const admin = `postgres://bos_owner@127.0.0.1:${port}/postgres`;
  for (let n=0;;n++) {
    const c = new pg.Client({connectionString:admin,connectionTimeoutMillis:200});
    try { await c.connect(); await c.query('CREATE DATABASE bos_rooms'); break; }
    catch (e) { if (n>60) throw e; await new Promise(r=>setTimeout(r,100)); }
    finally { await c.end().catch(()=>{}); }
  }
  return {port, owner:`postgres://bos_owner@127.0.0.1:${port}/bos_rooms`, async stop(){
    const done = new Promise<void>(r=>p.exitCode!==null?r():p.once('exit',()=>r()));
    p.kill('SIGTERM'); await done; await rm(dir,{recursive:true,force:true});
  }};
}
const baseEnv = (over: Record<string,string> = {}) => ({
  CLOUD_SERVICE_URL:'https://bos.example.test', CLOUD_ISSUER_URL:'https://bos.example.test',
  CLOUD_DATABASE_URL:'postgres://cloud_app:pw@postgres:5432/bos_rooms', CLOUD_SERVICE_KEY:randomBytes(32).toString('base64'), ...over,
}) as NodeJS.ProcessEnv;

test('config: https origins, private issuer, non-owner role and a persistent key are required', () => {
  assert.equal(readSelfHostConfig(baseEnv()).serviceURL,'https://bos.example.test');
  assert.throws(()=>readSelfHostConfig(baseEnv({CLOUD_ISSUER_URL:'https://accounts.openmausbot.com'})),/private issuer/);
  assert.throws(()=>readSelfHostConfig(baseEnv({CLOUD_ISSUER_URL:'https://x.openmausbot.com'})),/private issuer/);
  assert.throws(()=>readSelfHostConfig(baseEnv({CLOUD_SERVICE_URL:'http://bos.example.test'})),/https/);
  assert.throws(()=>readSelfHostConfig(baseEnv({CLOUD_SERVICE_URL:'https://bos.example.test/path'})),/https/);
  assert.throws(()=>readSelfHostConfig(baseEnv({CLOUD_DATABASE_URL:'postgres://bos_owner:pw@postgres/bos_rooms'})),/cloud_app/);
  assert.throws(()=>readSelfHostConfig(baseEnv({CLOUD_SERVICE_KEY:''})),/CLOUD_SERVICE_KEY/);
});

test('migrate is ledgered and idempotent; room validates through the private issuer; worker ticks', async () => {
  const c = await cluster();
  let room: Awaited<ReturnType<typeof startRoom>>|undefined, worker: ReturnType<typeof startWorker>|undefined;
  const issuerPort = await freePort();
  const seen: string[] = [];
  const issuer = createServer((req,res)=>{
    seen.push(req.url+' '+(req.headers.authorization ?? ''));
    if (req.url==='/v1/me' && req.headers.authorization==='Bearer good') { res.writeHead(200,{'content-type':'application/json'}); res.end(JSON.stringify({user:{id:'user-1',email:'a@example.test'}})); }
    else { res.writeHead(401); res.end('{}'); }
  });
  await new Promise<void>(r=>issuer.listen(issuerPort,'127.0.0.1',r));
  try {
    const first = await migrate(c.owner,'app-password-0123456789');
    assert.deepEqual(first,['001.sql','002_invite_outbox.sql','003_runtime.sql','004_push_revoke.sql','005_migration_authority.sql']);
    assert.deepEqual(await migrate(c.owner,'app-password-0123456789'),[]);
    await assert.rejects(migrate(c.owner,'short'),/16 characters/);
    const port = await freePort();
    const config = readSelfHostConfig(baseEnv({
      CLOUD_DATABASE_URL:`postgres://cloud_app:app-password-0123456789@127.0.0.1:${c.port}/bos_rooms`,
      CLOUD_ISSUER_INTERNAL_URL:`http://127.0.0.1:${issuerPort}`, CLOUD_LISTEN_HOST:'127.0.0.1', CLOUD_LISTEN_PORT:String(port),
    }));
    room = await startRoom(config);
    worker = startWorker(config,50);
    const me = await fetch(`http://127.0.0.1:${port}/v2/me`,{headers:{authorization:'Bearer good','x-subject':'spoof'}});
    assert.equal(me.status,200);
    const body = await me.json();
    assert.equal(body.issuer,'https://bos.example.test');
    assert.equal(body.subject,'user-1');
    assert.equal(body.service,'https://bos.example.test');
    const bad = await fetch(`http://127.0.0.1:${port}/v2/me`,{headers:{authorization:'Bearer bad'}});
    assert.equal(bad.status,401);
    assert.ok(seen.every(v=>v.startsWith('/v1/me ')));
    const ws = await fetch(`http://127.0.0.1:${port}/v2/workspaces`,{method:'POST',headers:{authorization:'Bearer good','content-type':'application/json'},body:JSON.stringify({name:'pilot'})});
    assert.ok([200,201].includes(ws.status), String(ws.status));
    await new Promise(r=>setTimeout(r,300));
  } finally {
    await worker?.close(); await room?.close();
    await new Promise<void>(r=>issuer.close(()=>r()));
    await c.stop();
  }
});
// branding compatibility (electron/branding-compat.json): data-home: existing desktop and companion homes, backups and lease recovery must open the same data; deployed-services: existing worker databases, service health identities and hosted addresses must not become a different service
