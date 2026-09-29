import assert from "node:assert/strict";
import test from "node:test";
import { createUpdateLifecycleClient } from "./update-lifecycle.mjs";
test("prepare validates receipt before persisting parent intent", async () => {
 const saved=[];
 const client=createUpdateLifecycleClient({ getConnection: () => ({ url:"http://127.0.0.1:1234", pid:123, generation:"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", token:"synthetic" }), recordIntent: async r => saved.push(r), fetch: async (_url, init) => ({ok:true,json:async()=>({...JSON.parse(init.body),version:1,pid:999,state:"prepared"})}) });
 await assert.rejects(client.prepareInstall(), /identity/); assert.equal(saved.length,0);
});
test("prepare fences identity and persists intent only after retained server receipt", async () => {
 const saved=[];let request;const actions=[];
 const client=createUpdateLifecycleClient({ getConnection:()=>({url:"http://127.0.0.1:1234",pid:123,generation:"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",token:"synthetic"}), recordIntent:async r=>saved.push(r), fetch:async (_url,init)=>{request=JSON.parse(init.body);actions.push(request.action);return {ok:true,json:async()=>({version:1,pid:123,generation:"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",nonce:request.nonce,state:request.action === "commit" ? "committed" : "prepared",preparedAt:new Date().toISOString()})};} });
 await client.prepareInstall();assert.equal(request.expectedPid,123);assert.equal(saved.length,1);assert.equal(saved[0].nonce,request.nonce);assert.deepEqual(actions,["prepare","commit"]);assert.equal(saved[0].state,"committed");
});
test("prepare rejects a receipt from another host generation", async () => {
 const client=createUpdateLifecycleClient({getConnection:()=>({url:"http://127.0.0.1:1234",pid:123,generation:"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",token:"synthetic"}),recordIntent:async()=>{},fetch:async(_url,init)=>({ok:true,json:async()=>({version:1,pid:123,generation:"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",nonce:JSON.parse(init.body).nonce,state:"prepared",preparedAt:new Date().toISOString()})})});
 await assert.rejects(client.prepareInstall(),/identity/);
});

test("cancelled preparation cannot persist parent intent without server commit", async () => {
 const saved=[];const actions=[];
 const client=createUpdateLifecycleClient({getConnection:()=>({url:"http://127.0.0.1:1234",pid:123,generation:"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",token:"synthetic"}),recordIntent:async r=>saved.push(r),fetch:async(_url,init)=>{const body=JSON.parse(init.body);actions.push(body.action);return body.action==="commit"?{ok:false}:{ok:true,json:async()=>({version:1,pid:123,generation:"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",nonce:body.nonce,state:"prepared",preparedAt:new Date().toISOString()})};}});
 await assert.rejects(client.prepareInstall(),/commit/);assert.deepEqual(actions,["prepare","commit"]);assert.equal(saved.length,0);
});
