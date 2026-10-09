import { compatEnv } from "../../../electron/branding-env.cjs";
// iOS cloud push without APNs. Starts the local fixture (local.ts), a
// 127.0.0.1 relay that turns a hint request into `xcrun simctl push`, and
// CloudRoomsLiveUITests/testPushRegistersAndTapOpensTheRoom on one simulator.
// The app registers with the room service for real; only delivery is
// simulated. /push builds the hint and checks it against PushHintSchema
// (exactly what PushHints.build stores); /push-raw sends an object as given,
// for the app's off-schema check.
//
//   node --experimental-strip-types services/cloud/acceptance/run-ios-push.mjs <repo> <out> <derived> <simulator-udid>
//
// <derived> is a build-for-testing derived data path for <repo>/ios. A
// banner tap that cold-launches the app carries no launch environment, so the
// cloud debug keys also go into the app's defaults for the run and are
// removed afterwards.
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdirSync,writeFileSync,readFileSync,openSync,closeSync} from 'node:fs';
import {resolve} from 'node:path';
import {promisify} from 'node:util';
const run=promisify(execFile);
const [serverArg,outArg,derivedArg,simulator]=process.argv.slice(2);
assert.ok(serverArg && outArg && derivedArg && simulator,'usage: run-ios-push.mjs <repo> <out> <derived> <simulator-udid>');
const server=resolve(serverArg),out=resolve(outArg),derived=resolve(derivedArg);
const bundle='com.aihlete.aios';
const {PushHintSchema}=await import(server+'/shared/cloud-protocol/index.ts');
mkdirSync(out,{mode:0o700});
const save=(name,value)=>writeFileSync(out+'/'+name,JSON.stringify(value,null,2)+'\n',{mode:0o600});
const children=new Set(),pushes=[];
function launch(name,command,args,options={}) {
 const fd=openSync(out+'/'+name+'.private.log','wx',0o600);
 const p=spawn(command,args,{cwd:server,env:compatEnv,stdio:['ignore',fd,fd],...options});closeSync(fd);children.add(p);
 p.done=new Promise((r,j)=>{p.on('error',j);p.on('exit',(code,signal)=>{children.delete(p);r({name,code,signal});});});
 return p;
}
async function stop(p){if(p && p.exitCode===null && !p.signalCode){p.kill('SIGTERM');await p.done;}}
async function wait(fn,p,label){for(let n=0;n<1200;n++){const v=fn();if(v)return v;assert.equal(p.exitCode,null,label+' exited');await new Promise(r=>setTimeout(r,100));}throw new Error(label+' startup deadline');}
const defaults=(...args)=>run('xcrun',['simctl','spawn',simulator,'defaults',...args]);
const keys=['BOS_CLOUD_ROOMS','CLOUD_ROOMS_URL','CLOUD_ISSUER_URL'];

// Same envelope a real APNs sender would use: a generic alert, the hint
// under bos_cloud, nothing else.
async function deliver(hint) {
 const n=pushes.length+1,file=out+'/push-'+n+'.json';
 const envelope={aps:{alert:{body:'New activity'},sound:'default',...(typeof hint.room_id==='string'?{'thread-id':hint.room_id}:{})},bos_cloud:hint};
 writeFileSync(file,JSON.stringify(envelope),{mode:0o600});
 await run('xcrun',['simctl','push',simulator,bundle,file]);
 pushes.push({at:new Date().toISOString(),envelope});save('pushes.json',pushes);
}
const relay=createServer(async(req,res)=>{
 const reply=(status,value)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
 try {
  let raw='';for await(const c of req)raw+=c;
  const body=JSON.parse(raw||'{}');
  if(req.method==='POST' && req.url==='/push'){
   const hint=PushHintSchema.parse({kind:'room_sync',workspace_id:body.workspace_id,room_id:body.room_id,event_id:body.event_id,preview:'New activity'});
   await deliver(hint);return reply(200,{delivered:hint});
  }
  if(req.method==='POST' && req.url==='/push-raw'){
   assert.equal(PushHintSchema.safeParse(body).success,false,'push-raw is for off-schema hints');
   await deliver(body);return reply(200,{delivered:body});
  }
  reply(404,{error:'not_found'});
 } catch(e){reply(400,{error:String(e.message).slice(0,500)});}
});

let fixture,set=false;
async function cleanup(){
 relay.close();
 if(set)for(const k of keys)await defaults('delete',bundle,k).catch(()=>{});
 for(const p of [...children])if(p!==fixture)await stop(p);
 await stop(fixture);
 save('cleanup.json',{at:new Date().toISOString(),owned_children_remaining:children.size,defaults_removed:set});
}
for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>cleanup().then(()=>process.exit(130)));
try {
 fixture=launch('fixture',process.execPath,['--experimental-strip-types','services/cloud/local.ts']);
 const state=await wait(()=>{for(const l of readFileSync(out+'/fixture.private.log','utf8').trim().split('\n')){try{const s=JSON.parse(l);if(s.url && s.issuer_url)return s;}catch{}}},fixture,'fixture');
 await new Promise(r=>relay.listen(0,'127.0.0.1',r));
 const relayURL='http://127.0.0.1:'+relay.address().port;
 for(const [k,v] of [['BOS_CLOUD_ROOMS','1'],['CLOUD_ROOMS_URL',state.url],['CLOUD_ISSUER_URL',state.issuer_url]])await defaults('write',bundle,k,'-string',v);
 set=true;
 save('preflight.json',{at:new Date().toISOString(),room:state.url,issuer:state.issuer_url,relay:relayURL,simulator,bundle});
 const ui=launch('ui','xcodebuild',['test-without-building','-project','BosBot.xcodeproj','-scheme','BosBot','-destination','id='+simulator,'-derivedDataPath',derived,
  '-only-testing:BosBotUITests/CloudRoomsLiveUITests/testPushRegistersAndTapOpensTheRoom','-parallel-testing-enabled','NO','-resultBundlePath',out+'/ui.xcresult'],
  {cwd:server+'/ios',env:{...compatEnv,TEST_RUNNER_CLOUD_ISSUER_URL:state.issuer_url,TEST_RUNNER_CLOUD_ROOMS_URL:state.url,TEST_RUNNER_CLOUD_PUSH_RELAY_URL:relayURL}});
 const result=await ui.done;
 const log=readFileSync(out+'/ui.private.log','utf8');
 const executed=/Executed 1 test, with 0 failures/.test(log),skipped=/skipped/i.test(log.match(/Test case .*testPushRegistersAndTapOpensTheRoom.*/g)?.join('\n')??'');
 save('summary.json',{at:new Date().toISOString(),result,executed,skipped,pushes:pushes.length});
 console.log(JSON.stringify({result,executed,skipped,pushes:pushes.length}));
 assert.ok(result.code===0 && executed && !skipped,'push ui test failed or skipped; see '+out+'/ui.private.log');
 assert.equal(pushes.length,4,'four pushes delivered');
}catch(e){console.error(e.message);process.exitCode=1;}finally{await cleanup();}
