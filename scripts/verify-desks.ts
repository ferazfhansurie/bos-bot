/** Desks end to end in a disposable server + native Electron; never the
 * installed app. Real `claude -p` turns (scripts/testing/blank-tab-turn.mjs
 * with the desks skill and desk tools) open a local fake ads manager as a
 * desk and write its cards; the real primary + shared bot browser give the
 * live view. Screenshots land in argv[2]. */
import {launchVerificationServer,verificationServerEnvironment} from './control-omb.ts';
import {mountPreview,fixtureApi} from './testing/preview-fixture.ts';
import {waitForExit} from '../server/testing/cleanup.ts';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import {createServer} from 'node:http';
import path from 'node:path';
const output=path.resolve(process.argv[2] ?? '.omb-scratch/verify-evidence/desks');
const token='wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww';
fs.mkdirSync(output,{recursive:true});for(const f of ['turns.jsonl','claude-session','verification.json'])fs.rmSync(path.join(output,f),{force:true});
const fixture=await launchVerificationServer();
let preview;
let managed;
let page;
try {
 await waitForExit(fixture.child,{signal:'SIGTERM'});
 const preload=path.join(fixture.info.dataDir,'desktop-parent.mjs');
 fs.writeFileSync(preload,`process.parentPort={on(name,fn){if(name==='message')setImmediate(()=>fn({data:{type:'openmausbot:desktop-mutation-token',token:'${token}'}}));},postMessage(){}};`);
 const prompts=path.join(fixture.info.dataDir,'prompts.jsonl');
 const tools=['desk_open','desk_card','desk_list','desk_remove'].map(t=>`mcp__agents__${t}`).join(',');
 const managedEnv=verificationServerEnvironment({...process.env,FAKE_CLAUDE_PROMPTS:prompts,FAKE_CLAUDE_TURN_COMMAND:`${JSON.stringify(process.execPath)} ${JSON.stringify(path.resolve('scripts/testing/blank-tab-turn.mjs'))}`,FAKE_CLAUDE_TURN_EVIDENCE:output,FAKE_CLAUDE_TURN_SKILL:'desks',FAKE_CLAUDE_TURN_TOOLS:tools,FAKE_CLAUDE_TURN_ENV:JSON.stringify(Object.fromEntries(['HOME','USER','LOGNAME','SHELL','PATH','TMPDIR','LANG'].flatMap(k=>process.env[k]?[[k,process.env[k]]]:[])))},fixture.info.dataDir,Number(new URL(fixture.info.url).port));managedEnv.OMB_DESKTOP_PARENT='1';
 const log=fs.openSync(fixture.info.logPath,'a');
 managed=spawn(process.execPath,['--experimental-strip-types','--import',preload,path.resolve('server/index.ts')],{env:managedEnv,stdio:['ignore',log,log]});fs.closeSync(log);
 for(let i=0;;i++){if(managed.exitCode!==null)throw new Error('managed fixture exited');if(await fetch(fixture.info.url+'/api/health').then(r=>r.ok).catch(()=>false))break;if(i>600)throw new Error('managed fixture startup; see '+fixture.info.logPath);await new Promise(r=>setTimeout(r,100));}
 const api=fixtureApi(fixture.info.url,{headers:{'x-openmausbot-desktop-owner':token,origin:fixture.info.url}});
 await api('PATCH','/api/config',{language:'en'});
 const {bot}=await api('POST','/api/bots',{name:'Desks fixture',modelSelection:{instanceId:'claude',model:'claude-sonnet-5'}});
 await api('POST',`/api/bots/${bot.id}/tasks`,{});
 // a stand-in ads manager: one page, made-up numbers, nothing leaves the machine
 page=createServer((_req,res)=>{res.setHeader('content-type','text/html');res.end('<style>body{background:#f4f6f8;color:#1c2b33;font:15px system-ui;padding:28px}table{border-collapse:collapse;margin-top:16px}td,th{padding:8px 16px;border-bottom:1px solid #dde3e8;text-align:left}</style><title>Fixture Ads Manager</title><h1>Fixture Ads Manager</h1><p>Today\'s spend: RM42.00</p><table><tr><th>Ad</th><th>Spend</th><th>Results</th></tr><tr><td>meet my hires</td><td>RM20.00</td><td>3 sign-ups</td></tr><tr><td>free setup</td><td>RM12.00</td><td>1 sign-up</td></tr><tr><td>whatsapp demo</td><td>RM10.00</td><td>0</td></tr></table>');});
 await new Promise<void>(resolve=>page!.listen(0,'127.0.0.1',resolve));
 const pageURL=`http://127.0.0.1:${(page.address() as {port:number}).port}/`;
 preview=await mountPreview(fixture,{entry:'/scripts/testing/blank-tab-preview.tsx',route:'/__desks.html',title:'Isolated desks',logLevel:'warn'});
 const {ELECTRON_RUN_AS_NODE:_node,...env}=process.env;
 const child=spawn(path.resolve('node_modules/.bin/electron'),['scripts/verify-desks-native.mjs',preview.previewUrl,fixture.info.dataDir,output,fixture.info.url,pageURL,bot.id],{env,stdio:'inherit'});
 const code=await new Promise(resolve=>child.on('exit',resolve));
 if(code!==0)throw new Error(`native fixture exit ${code}`);
}finally{page?.close();await preview?.close();if(managed)await waitForExit(managed,{signal:'SIGTERM'});await fixture.close();}
