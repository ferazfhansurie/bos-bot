import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../fixture.ts';
import { CloudService } from '../service.ts';
import { ControlPlaneIssuer } from '../identity.ts';
import { startCloud } from '../http.ts';
import { Database } from '../db.ts';
import { randomBytes } from 'node:crypto';

test('real entrypoint returns 404 for test signin and hooks with no env override', async () => {
 const f = await fixture(false);
 let app;
 try {
   const service = new CloudService(new Database(f.database_url),new ControlPlaneIssuer('http://127.0.0.1:9990','http://127.0.0.1:9991'),'http://127.0.0.1:9991',randomBytes(32));
   app = await startCloud(service);
   for (const path of ['/v2/test/sign-in','/v2/test/hooks/control']) {
     const r: Response = await fetch(app.url+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({subject:'fictional_alice'})});
     assert.equal(r.status,404);
   }
   const r: Response = await fetch(app.url+'/v2/me',{headers:{authorization:'Bearer invalid','x-subject':'owner','x-account-id':'owner'}});
   assert.equal(r.status,503);
   assert.deepEqual(await r.json(),{error:'identity_unavailable',retry_after:1});
 } finally { if(app) await app.close(); await f.stop(); }
});
