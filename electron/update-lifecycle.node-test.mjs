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

const generation = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
function lifecycleServer({ pid = () => 123, gen = () => generation, refuse = () => false, commitFails = () => false } = {}) {
  const calls = [];
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    if (refuse(body)) return { ok: false };
    if (body.action === "commit" && commitFails()) return { ok: false };
    return { ok: true, json: async () => ({ version: 1, pid: pid(), generation: gen(), nonce: body.nonce, state: body.action === "commit" ? "committed" : "prepared", preparedAt: new Date().toISOString() }) };
  };
  return { calls, fetch };
}

test("a busy refusal clears the nonce so the next quit starts a fresh preparation", async () => {
  let busy = true;
  const server = lifecycleServer({ refuse: body => busy && body.action === "prepare" });
  const client = createUpdateLifecycleClient({ getConnection: () => ({ url: "http://127.0.0.1:1234", pid: 123, generation, token: "synthetic" }), recordIntent: async () => {}, fetch: server.fetch });
  await assert.rejects(client.prepareInstall(), /prepare refused/);
  busy = false;
  const receipt = await client.prepareInstall();
  assert.equal(receipt.state, "committed");
  assert.notEqual(server.calls[0].nonce, server.calls[1].nonce);
});

test("a server restart after a prepared receipt rebinds the nonce instead of wedging every quit", async () => {
  let pid = 123;
  let commitFails = true;
  const server = lifecycleServer({ pid: () => pid, commitFails: () => commitFails });
  const client = createUpdateLifecycleClient({ getConnection: () => ({ url: "http://127.0.0.1:1234", pid, generation, token: "synthetic" }), recordIntent: async () => {}, fetch: server.fetch });
  await assert.rejects(client.prepareInstall(), /commit refused/);
  pid = 456;
  commitFails = false;
  const receipt = await client.prepareInstall();
  assert.equal(receipt.pid, 456);
  assert.equal(receipt.nonce, server.calls[0].nonce);
  assert.deepEqual(server.calls.map(call => call.expectedPid), [123, 123, 456, 456]);
});

test("a new host generation drops a retained nonce instead of throwing", async () => {
  let gen = generation;
  let commitFails = true;
  const server = lifecycleServer({ gen: () => gen, commitFails: () => commitFails });
  const client = createUpdateLifecycleClient({ getConnection: () => ({ url: "http://127.0.0.1:1234", pid: 123, generation: gen, token: "synthetic" }), recordIntent: async () => {}, fetch: server.fetch });
  await assert.rejects(client.prepareInstall(), /commit refused/);
  gen = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  commitFails = false;
  assert.equal((await client.prepareInstall()).generation, gen);
  assert.notEqual(server.calls[2].nonce, server.calls[0].nonce);
});

test("an ambiguous prepare keeps its nonce for the retry", async () => {
  let drop = true;
  const server = lifecycleServer();
  const nonces = [];
  const client = createUpdateLifecycleClient({ getConnection: () => ({ url: "http://127.0.0.1:1234", pid: 123, generation, token: "synthetic" }), recordIntent: async () => {},
    fetch: async (url, init) => { nonces.push(JSON.parse(init.body).nonce); if (drop) { drop = false; throw new Error("The operation was aborted due to timeout"); } return server.fetch(url, init); } });
  await assert.rejects(client.prepareInstall(), /timeout/);
  await client.prepareInstall();
  assert.equal(new Set(nonces).size, 1);
});

test("no owned server (dead, booting, shut down) is idle: nothing is fetched or recorded", async () => {
  const saved = [];
  const client = createUpdateLifecycleClient({ getConnection: () => null, recordIntent: async r => saved.push(r), fetch: async () => assert.fail("no server to ask") });
  assert.deepEqual(await client.prepareInstall(), { version: 1, state: "idle" });
  assert.equal(saved.length, 0);
});

test("a refused connection on the owned port is idle; a restore in progress is not", async () => {
  const refused = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  const client = createUpdateLifecycleClient({ getConnection: () => ({ url: "http://127.0.0.1:1234", pid: 123, generation, token: "synthetic" }), recordIntent: async () => assert.fail("nothing prepared"), fetch: async () => { throw refused; } });
  assert.equal((await client.prepareInstall()).state, "idle");
  const restoring = createUpdateLifecycleClient({ getConnection: () => { throw new Error("A company restore is in progress."); }, recordIntent: async () => {}, fetch: async () => assert.fail("not asked") });
  await assert.rejects(restoring.prepareInstall(), /restore/);
});
