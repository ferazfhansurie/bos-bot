import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import * as identity from '../identity.ts';

test('real issuer validates immutable subject fresh, distinguishes revocation from outage and forwards only credentials', async () => {
  const Adapter = (identity as any).ControlPlaneIssuer;
  assert.equal(typeof Adapter, 'function', 'real issuer adapter missing');
  let status = 200;
  let malformed = false;
  const calls: any[] = [];
  const server = createServer((req,res) => {
    calls.push({url:req.url,headers:req.headers});
    res.writeHead(status, {'content-type':'application/json'});
    res.end(JSON.stringify(malformed ? {user:{email:'alice@example.test'}} : {user:{id:'immutable-subject', email:'alice@example.test'}}));
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  try {
    const issuer = 'http://127.0.0.1:'+(server.address() as any).port;
    const adapter = new Adapter(issuer,'http://127.0.0.1:9900');
    const a = await identity.currentIdentity(adapter,'signed-bearer');
    const b = await identity.currentIdentity(adapter,'cookie\0better-auth.session_token=signed-cookie');
    assert.equal(a.subject,'immutable-subject');
    assert.equal(a.account_id,b.account_id);
    assert.equal(a.issuer,issuer);
    assert.equal(a.service,'http://127.0.0.1:9900');
    assert.ok(a.expires_at-a.validated_at<=15000);
    assert.equal(calls.length,2);
    assert.equal(calls[0].url,'/v1/me');
    assert.equal(calls[0].headers.authorization,'Bearer signed-bearer');
    assert.equal(calls[0].headers['cache-control'],'no-cache, no-store');
    assert.equal(calls[1].headers.cookie,'better-auth.session_token=signed-cookie');
    assert.equal(calls[1].headers.authorization,undefined);
    status = 401;
    await assert.rejects(identity.currentIdentity(adapter,'signed-bearer'),{code:'session_invalid',status:401});
    status = 503;
    await assert.rejects(identity.currentIdentity(adapter,'signed-bearer'),{code:'identity_unavailable',status:503});
    status = 200; malformed = true;
    await assert.rejects(identity.currentIdentity(adapter,'signed-bearer'),{code:'identity_unavailable'});
  } finally { await new Promise<void>(r=>server.close(()=>r())); }
});
