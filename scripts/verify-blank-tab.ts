/** Blank tab end to end in a disposable server + native Electron; never the
 * installed app. The fixture's engine is the fake CLI, but each turn is done
 * by a real `claude -p` (scripts/testing/blank-tab-turn.mjs; FAKE_CLAUDE_TURN_CLAUDE,
 * default `claude` on PATH) with the turn's own system prompt and agents MCP
 * server, so the skill pick, open_tab and the tab opening are all real.
 * Screenshots land in argv[2]. */
import {launchVerificationServer,verificationServerEnvironment} from './control-omb.ts';
import {mountPreview,fixtureApi} from './testing/preview-fixture.ts';
import {waitForExit} from '../server/testing/cleanup.ts';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const output=path.resolve(process.argv[2] ?? '.omb-scratch/verify-evidence/blank-tab');
const token='wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww';
fs.mkdirSync(output,{recursive:true});for(const f of ['turns.jsonl','claude-session'])fs.rmSync(path.join(output,f),{force:true});
const fixture=await launchVerificationServer();
let preview;
let managed;
try {
 await waitForExit(fixture.child,{signal:'SIGTERM'});
 const preload=path.join(fixture.info.dataDir,'desktop-parent.mjs');
 fs.writeFileSync(preload,`process.parentPort={on(name,fn){if(name==='message')setImmediate(()=>fn({data:{type:'openmausbot:desktop-mutation-token',token:'${token}'}}));},postMessage(){}};`);
 const prompts=path.join(fixture.info.dataDir,'prompts.jsonl');
 const managedEnv=verificationServerEnvironment({...process.env,FAKE_CLAUDE_PROMPTS:prompts,FAKE_CLAUDE_TURN_COMMAND:`${JSON.stringify(process.execPath)} ${JSON.stringify(path.resolve('scripts/testing/blank-tab-turn.mjs'))}`,FAKE_CLAUDE_TURN_EVIDENCE:output,FAKE_CLAUDE_TURN_ENV:JSON.stringify(Object.fromEntries(['HOME','USER','LOGNAME','SHELL','PATH','TMPDIR','LANG'].flatMap(k=>process.env[k]?[[k,process.env[k]]]:[])))},fixture.info.dataDir,Number(new URL(fixture.info.url).port));managedEnv.OMB_DESKTOP_PARENT='1';
 const log=fs.openSync(fixture.info.logPath,'a');
 managed=spawn(process.execPath,['--experimental-strip-types','--import',preload,path.resolve('server/index.ts')],{env:managedEnv,stdio:['ignore',log,log]});fs.closeSync(log);
 for(let i=0;;i++){if(managed.exitCode!==null)throw new Error('managed fixture exited');if(await fetch(fixture.info.url+'/api/health').then(r=>r.ok).catch(()=>false))break;if(i>600)throw new Error('managed fixture startup; see '+fixture.info.logPath);await new Promise(r=>setTimeout(r,100));}
 const api=fixtureApi(fixture.info.url,{headers:{'x-openmausbot-desktop-owner':token,origin:fixture.info.url}});
 await api('PATCH','/api/config',{language:'en'});
 const {bot}=await api('POST','/api/bots',{name:'Blank tab fixture',modelSelection:{instanceId:'claude',model:'claude-sonnet-5'}});
 await api('POST',`/api/bots/${bot.id}/tasks`,{});
 preview=await mountPreview(fixture,{entry:'/scripts/testing/blank-tab-preview.tsx',route:'/__blank-tab.html',title:'Isolated blank tab',logLevel:'warn'});
 const {ELECTRON_RUN_AS_NODE:_node,...env}=process.env;
 const child=spawn(path.resolve('node_modules/.bin/electron'),['scripts/verify-blank-tab-native.mjs',preview.previewUrl,fixture.info.dataDir,output,fixture.info.url,prompts],{env,stdio:'inherit'});
 const code=await new Promise(resolve=>child.on('exit',resolve));
 if(code!==0)throw new Error(`native fixture exit ${code}`);
}finally{await preview?.close();if(managed)await waitForExit(managed,{signal:'SIGTERM'});await fixture.close();}
