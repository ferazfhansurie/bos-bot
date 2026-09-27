import { createServer } from "node:http";
import { expect, it } from "vitest";
import { launchVerificationServer } from "../../scripts/control-omb.ts";
import { createProxyHandler } from "../src/proxy.ts";
import { denyReason } from "../src/routes.ts";
it('allows only authenticated GET usage reads', () => {
  expect(denyReason({method:'GET',path:'/api/provider-usage',authenticated:true})).toBeNull();
  expect(denyReason({method:'GET',path:'/api/provider-usage',authenticated:false})?.status).toBe(401);
  for (const method of ['POST','PUT','PATCH','DELETE']) expect(denyReason({method,path:'/api/provider-usage',authenticated:true})).not.toBeNull();
  expect(denyReason({method:'GET',path:'/api/provider-usage/credentials',authenticated:true})).not.toBeNull();
});
it('paired phone reaches real isolated usage endpoint', async () => {
 const fixture=await launchVerificationServer();
 const sidecar=createServer(createProxyHandler({harnessPort:Number(new URL(fixture.info.url).port),authenticate:value=>value==='fixture-token'?{id:'phone',cloudDesktopAccess:false}:null,redeem:()=>({error:'disabled'}),serverName:()=> 'Fixture'}));
 try {
  await new Promise<void>(resolve=>sidecar.listen(0,'127.0.0.1',resolve));
  const address=sidecar.address();if(!address||typeof address==='string')throw Error('no port');
  const url=`http://127.0.0.1:${address.port}/api/provider-usage`;
  expect((await fetch(url)).status).toBe(401);
  const response=await fetch(url,{headers:{authorization:'Bearer fixture-token'}});
  expect(response.status).toBe(200);
  const body=await response.json();expect(Array.isArray(body.accounts)).toBe(true);
  expect(body).toEqual(await (await fetch(`${fixture.info.url}/api/provider-usage`)).json());
 } finally {await new Promise<void>(resolve=>sidecar.close(()=>resolve()));await fixture.close();}
},30000);
