import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWindowsUpdateContract, createWindowsUpdateResultWriter, createCheckpointUpdateLifecycle, createWindowsUpdateHealthVerifier } from "./windows-update-contract.mjs";

const id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
function fixture(t) {
 const dir=mkdtempSync(join(tmpdir(),"bos-win-contract-"));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const plan={updateId:id,mode:"update",version:"1.3.0",sha:"07".repeat(64),oldVersion:"1.0.0",oldSha:"unknown",force:false,resultPath:join(dir,"updates",id,"result.json"),installedPath:join(dir,"updates","installed.json"),health:"http://127.0.0.1:18999/api/health",ports:[18999],gracefulSeconds:10,healthSeconds:30};
 const replies=[],actions=[]; const proc={postMessage:m=>replies.push(m)};
 let current="1.0.0";
 const writer=createWindowsUpdateResultWriter({dataDir:dir,currentVersion:()=>current,hostPid:11,verifyHealth:async()=>true});
 const contract=createWindowsUpdateContract({coordinator:{candidate:()=>({version:plan.version,sha:plan.sha,stagedAt:"2026-10-04T00:00:00Z"}),admit:()=>{},install:async({prepareInstall})=>{await prepareInstall();actions.push("install");return {dispatched:true};}},lifecycleClient:{prepareInstall:async()=>actions.push("intent")},relaunch:()=>actions.push("restart"),resultWriter:writer});
 const send=async(type,extra={})=>{assert.equal(contract.receive(proc,{type:`openmausbot:update-${type}`,requestId:"r1",...extra}),true);for(let n=0;n<10;n++)await new Promise(setImmediate);return replies.at(-1);};
 return {dir,plan,writer,contract,actions,replies,send,proc,setVersion:v=>current=v};
}
test("private candidate reply uses the shared shape",async t=>{
 const h=fixture(t);const reply=await h.send("candidate");assert.equal(reply.type,"openmausbot:update-candidate-result");assert.equal(reply.candidate.sha,h.plan.sha);
});
test("execute persists plan and host intent before acknowledgement and quits once",async t=>{
 const h=fixture(t);const r=await h.send("execute",{plan:h.plan});assert.equal(r.ok,true);assert.deepEqual(h.actions,["intent","install"]);
 assert.ok(h.writer.readPending());assert.equal(existsSync(h.plan.resultPath),false);
 const again=await h.send("execute",{plan:h.plan});assert.equal(again.ok,false);assert.equal(again.status,409);assert.deepEqual(h.actions,["intent","install"]);
});
test("restart relaunches without calling NSIS",async t=>{
 const h=fixture(t);h.plan.mode="restart";h.plan.version="1.0.0";h.plan.sha="unknown";
 assert.equal((await h.send("execute",{plan:h.plan})).ok,true);assert.deepEqual(h.actions,["intent","restart"]);
});
test("result is not written in the old host and appears after healthy new host",async t=>{
 const h=fixture(t);await h.send("execute",{plan:h.plan});await h.contract.onServerHealthy();assert.equal(existsSync(h.plan.resultPath),false);
 h.setVersion("1.3.0");const newWriter=createWindowsUpdateResultWriter({dataDir:h.dir,currentVersion:()=>"1.3.0",hostPid:12,verifyHealth:async()=>true});
 const newContract=createWindowsUpdateContract({coordinator:{},lifecycleClient:{},resultWriter:newWriter});await newContract.onServerHealthy();
 assert.equal(JSON.parse(readFileSync(h.plan.resultPath)).state,"done");assert.deepEqual(JSON.parse(readFileSync(h.plan.installedPath)),{version:h.plan.version,sha:h.plan.sha});assert.equal(newWriter.readPending(),null);
 await newContract.onServerHealthy();assert.equal(JSON.parse(readFileSync(h.plan.resultPath)).updateId,id);
});
test("wrong installed version fails with manual recovery, never claims rollback",async t=>{
 const h=fixture(t);await h.send("execute",{plan:h.plan});const writer=createWindowsUpdateResultWriter({dataDir:h.dir,currentVersion:()=>"1.0.0",hostPid:12,verifyHealth:async()=>true});await writer.complete();
 const result=JSON.parse(readFileSync(h.plan.resultPath));assert.equal(result.state,"failed");assert.equal(result.manualRecoveryRequired,true);assert.equal(existsSync(h.plan.installedPath),false);
});
test("failed health refuses success even when installed version matches",async t=>{
 const h=fixture(t);await h.send("execute",{plan:h.plan});const writer=createWindowsUpdateResultWriter({dataDir:h.dir,currentVersion:()=>"1.3.0",hostPid:12,verifyHealth:async()=>false});await writer.complete();assert.equal(JSON.parse(readFileSync(h.plan.resultPath)).state,"failed");
});
test("foreign result paths, remote health and malformed request IDs cannot dispatch",async t=>{
 const h=fixture(t);assert.equal(h.contract.receive(h.proc,{type:"irrelevant"}),false);
 h.contract.receive(h.proc,{type:"openmausbot:update-execute",requestId:"x".repeat(101),plan:h.plan});await new Promise(setImmediate);assert.equal(h.replies.length,0);
 for(const patch of [{resultPath:join(h.dir,"foreign.json")},{health:"http://example.com/api/health"},{mode:"other"}])assert.equal((await h.send("execute",{plan:{...h.plan,...patch}})).ok,false);
 assert.deepEqual(h.actions,[]);
});
test("pending durable intent refuses admission after relaunch until health is settled",async t=>{
 const h=fixture(t);await h.send("execute",{plan:h.plan});const c=createWindowsUpdateContract({coordinator:{admit:()=>{}},resultWriter:h.writer});const replies=[];
 c.receive({postMessage:m=>replies.push(m)},{type:"openmausbot:update-admit",requestId:"r2",mode:"restart"});await new Promise(setImmediate);assert.equal(replies[0].status,409);
});

test("candidate mismatch and lifecycle failure retain safe installation behavior",async t=>{
 const h=fixture(t);assert.equal((await h.send("execute",{plan:{...h.plan,sha:"different"}})).ok,false);assert.equal(h.writer.readPending(),null);
 const c=createWindowsUpdateContract({coordinator:{candidate:()=>({version:h.plan.version,sha:h.plan.sha}),admit:()=>{},install:async({prepareInstall})=>{await prepareInstall();throw new Error("must not dispatch");}},lifecycleClient:{prepareInstall:async()=>{throw new Error("checkpoint missing");}},resultWriter:h.writer});
 const replies=[];c.receive({postMessage:m=>replies.push(m)},{type:"openmausbot:update-execute",requestId:"r3",plan:h.plan});for(let i=0;i<10;i++)await new Promise(setImmediate);
 assert.equal(replies[0].ok,false);assert.equal(replies[0].pending,true);assert.ok(h.writer.readPending());assert.equal(existsSync(h.plan.resultPath),false);
});

test("coordinated lifecycle requires the stopped checkpoint before host intent",async t=>{
 const h=fixture(t);let intents=0;let owned=true;
 const lifecycle=createCheckpointUpdateLifecycle({dataDir:h.dir,isOwned:()=>owned,recordIntent:()=>intents++});
 await assert.rejects(lifecycle.prepareInstall(h.plan),/checkpoint/);assert.equal(intents,0);
 mkdirSync(join(h.dir,"updates",id),{recursive:true});const checkpoint=join(h.dir,"updates",id,"checkpoint.json");
 writeFileSync(checkpoint,JSON.stringify({version:1,updateId:id,mode:"update",turns:[],stoppedAt:"2026-10-04T00:00:00Z"}));
 await lifecycle.prepareInstall(h.plan);assert.equal(intents,1);
 owned=false;await assert.rejects(lifecycle.prepareInstall(h.plan),/owner/);assert.equal(intents,1);
});
test("health checks the exact owned server and every required port",async()=>{
 const ports=[];let requests=0;
 const verify=createWindowsUpdateHealthVerifier({getConnection:()=>({url:"http://127.0.0.1:18999",pid:42}),fetch:async()=>{requests++;return {ok:true,json:async()=>({app:"openmausbot",pid:42,static:true})};},checkPort:async port=>{ports.push(port);return true;}});
 const plan={health:"http://127.0.0.1:18999/api/health",ports:[18999,8812],healthSeconds:0.01};
 assert.equal(await verify(plan),true);assert.deepEqual(ports,[18999,8812]);assert.equal(requests,1);
 assert.equal(await verify({...plan,health:"http://127.0.0.1:19000/api/health"}),false);assert.equal(requests,1);
});

test("host generation distinguishes recycled process IDs", async t=>{
 const h=fixture(t);const old=createWindowsUpdateResultWriter({dataDir:h.dir,currentVersion:()=>"1.0.0",hostPid:42,hostId:"old-generation",verifyHealth:async()=>true});old.persistPlan(h.plan);
 const next=createWindowsUpdateResultWriter({dataDir:h.dir,currentVersion:()=>"1.3.0",hostPid:42,hostId:"new-generation",verifyHealth:async()=>true});await next.complete();assert.equal(JSON.parse(readFileSync(h.plan.resultPath)).state,"done");
});

test("real coordinator, checkpoint and loopback health complete a sandboxed Windows handoff",async t=>{
 const { EventEmitter }=await import("node:events");const { createServer }=await import("node:http");
 const { createUpdaterCoordinator }=await import("./updater-coordinator.mjs");const { createHostLifecycle, readHostLifecycle }=await import("./host-lifecycle.mjs");
 const h=fixture(t);const http=createServer((req,res)=>{assert.equal(req.headers["x-openmausbot-desktop-owner"],"synthetic");res.setHeader("content-type","application/json");res.end(JSON.stringify({app:"openmausbot",pid:42,static:true}));});
 await new Promise(resolve=>http.listen(0,"127.0.0.1",resolve));t.after(()=>new Promise(resolve=>http.close(resolve)));
 const port=http.address().port;h.plan.health=`http://127.0.0.1:${port}/api/health`;h.plan.ports=[port];h.plan.healthSeconds=2;
 const host=createHostLifecycle(h.dir);host.childStarted(42);host.ready(42);
 mkdirSync(join(h.dir,"updates",id),{recursive:true});writeFileSync(join(h.dir,"updates",id,"checkpoint.json"),JSON.stringify({version:1,updateId:id,mode:"update",turns:[],stoppedAt:new Date().toISOString()}));
 const updater=new EventEmitter();updater.downloadUpdate=async()=>{updater.emit("update-downloaded",{version:h.plan.version,sha512:Buffer.from(h.plan.sha,"hex").toString("base64")});return [join(h.dir,"BOS.exe")];};
 const order=[];updater.quitAndInstall=()=>order.push("nsis");
 const coordinator=createUpdaterCoordinator(updater,()=>{}, {prepareInstall:async()=>{throw new Error("second maintenance gate");}});await coordinator.download();
 const writer=createWindowsUpdateResultWriter({dataDir:h.dir,currentVersion:()=>"1.0.0",hostId:host.generation});
 const contract=createWindowsUpdateContract({coordinator,resultWriter:writer,lifecycleClient:createCheckpointUpdateLifecycle({dataDir:h.dir,isOwned:()=>true,recordIntent:plan=>host.maintenance(`update:${plan.updateId}`)})});
 contract.receive({postMessage:r=>{assert.equal(r.ok,true);assert.ok(writer.readPending());assert.equal(readHostLifecycle(h.dir).phase,"maintenance");order.push("accepted");}}, {type:"openmausbot:update-execute",requestId:"sandbox",plan:h.plan});
 for(let i=0;i<10;i++)await new Promise(setImmediate);assert.deepEqual(order,["accepted","nsis"]);
 const next=createWindowsUpdateResultWriter({dataDir:h.dir,currentVersion:()=>h.plan.version,hostId:"new-generation",verifyHealth:createWindowsUpdateHealthVerifier({getConnection:()=>({url:`http://127.0.0.1:${port}`,pid:42,token:"synthetic"})})});
 await next.complete();assert.equal(JSON.parse(readFileSync(h.plan.resultPath)).state,"done");assert.equal(next.readPending(),null);
});
