/** New tab pins end to end in a disposable server + native Electron; never the
 * installed app. No model: the pages are written straight into each chat's
 * folder. Pins a page from its blank tab, finds it in the next new tab's
 * Tools, opens it from a second chat (which has its own folder), and adds one
 * through "Add a tab you made". Screenshots land in argv[2]. */
import {launchVerificationServer,verificationServerEnvironment} from './control-omb.ts';
import {mountPreview,fixtureApi} from './testing/preview-fixture.ts';
import {waitForExit} from '../server/testing/cleanup.ts';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const output=path.resolve(process.argv[2] ?? '.omb-scratch/verify-evidence/newtab-pins');
const token='wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww';
fs.mkdirSync(output,{recursive:true});
const fixture=await launchVerificationServer();
let preview;
let managed;
try {
 await waitForExit(fixture.child,{signal:'SIGTERM'});
 const preload=path.join(fixture.info.dataDir,'desktop-parent.mjs');
 fs.writeFileSync(preload,`process.parentPort={on(name,fn){if(name==='message')setImmediate(()=>fn({data:{type:'openmausbot:desktop-mutation-token',token:'${token}'}}));},postMessage(){}};`);
 const managedEnv=verificationServerEnvironment({...process.env},fixture.info.dataDir,Number(new URL(fixture.info.url).port));managedEnv.OMB_DESKTOP_PARENT='1';
 const log=fs.openSync(fixture.info.logPath,'a');
 managed=spawn(process.execPath,['--experimental-strip-types','--import',preload,path.resolve('server/index.ts')],{env:managedEnv,stdio:['ignore',log,log]});fs.closeSync(log);
 for(let i=0;;i++){if(managed.exitCode!==null)throw new Error('managed fixture exited');if(await fetch(fixture.info.url+'/api/health').then(r=>r.ok).catch(()=>false))break;if(i>600)throw new Error('managed fixture startup; see '+fixture.info.logPath);await new Promise(r=>setTimeout(r,100));}
 const api=fixtureApi(fixture.info.url,{headers:{'x-openmausbot-desktop-owner':token,origin:fixture.info.url}});
 await api('PATCH','/api/config',{language:'en'});
 const {bot}=await api('POST','/api/bots',{name:'Pins fixture',modelSelection:{instanceId:'claude',model:'claude-sonnet-5'}});
 await api('POST',`/api/bots/${bot.id}/tasks`,{});
 preview=await mountPreview(fixture,{entry:'/scripts/testing/blank-tab-preview.tsx',route:'/__blank-tab.html',title:'Isolated new tab pins',logLevel:'warn'});
 const {ELECTRON_RUN_AS_NODE:_node,...env}=process.env;
 const child=spawn(path.resolve('node_modules/.bin/electron'),['scripts/verify-newtab-pins-native.mjs',preview.previewUrl,fixture.info.dataDir,output,fixture.info.url,bot.id],{env,stdio:'inherit'});
 const code=await new Promise(resolve=>child.on('exit',resolve));
 if(code!==0)throw new Error(`native fixture exit ${code}`);
}finally{await preview?.close();if(managed)await waitForExit(managed,{signal:'SIGTERM'});await fixture.close();}
