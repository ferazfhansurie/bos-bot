/** Starts only disposable data/server/native Electron; never the installed app. */
import {launchVerificationServer,verificationServerEnvironment} from './control-omb.ts';
import {mountPreview,fixtureApi} from './testing/preview-fixture.ts';
import {waitForExit} from '../server/testing/cleanup.ts';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import {createServer} from 'node:http';
import path from 'node:path';
const output=path.resolve(process.argv[2] ?? '.omb-scratch/verify-evidence/workbench');
const fixture=await launchVerificationServer();
let preview;
let managed;
let page;
try {
 await waitForExit(fixture.child,{signal:'SIGTERM'});
 const preload=path.join(fixture.info.dataDir,'desktop-parent.mjs');
 fs.writeFileSync(preload,`process.parentPort={on(name,fn){if(name==='message')setImmediate(()=>fn({data:{type:'openmausbot:desktop-mutation-token',token:'wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww'}}));},postMessage(){}};`);
 const managedEnv=verificationServerEnvironment(process.env,fixture.info.dataDir,Number(new URL(fixture.info.url).port));managedEnv.OMB_DESKTOP_PARENT='1';
 const log=fs.openSync(fixture.info.logPath,'a');
 managed=spawn(process.execPath,['--experimental-strip-types','--import',preload,path.resolve('server/index.ts')],{env:managedEnv,stdio:['ignore',log,log]});fs.closeSync(log);
 for(let i=0;;i++){if(managed.exitCode!==null)throw new Error('managed fixture exited');if(await fetch(fixture.info.url+'/api/health').then(r=>r.ok).catch(()=>false))break;if(i>600)throw new Error('managed fixture startup; see '+fixture.info.logPath);await new Promise(r=>setTimeout(r,100));}

 const api=fixtureApi(fixture.info.url,{headers:{'x-openmausbot-desktop-owner':'wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww',origin:fixture.info.url}});
 await api('PATCH','/api/config',{language:'en'});
 const {bot}=await api('POST','/api/bots',{name:'Panel fixture',modelSelection:{instanceId:'claude',model:'claude-sonnet-5'}});
 await api('POST',`/api/bots/${bot.id}/tasks`,{});
 fs.writeFileSync(path.join(fixture.info.dataDir,'panel-note.txt'),'isolated workspace note');
 page=createServer((_req,res)=>{res.setHeader('content-type','text/html');res.end('<style>body{background:#fff;color:#222;font:16px system-ui;padding:24px}</style><title>Panel browser fixture</title><h1>panel page</h1><input id="panel-input">');});
 await new Promise<void>(resolve=>page!.listen(0,'127.0.0.1',resolve));
 const pageURL=`http://127.0.0.1:${(page.address() as {port:number}).port}/`;
 preview=await mountPreview(fixture,{entry:'/scripts/testing/workbench-preview.tsx',route:'/__workbench.html',title:'Isolated workbench',logLevel:'warn'});
 const {ELECTRON_RUN_AS_NODE:_node,...env}=process.env;
 const child=spawn(path.resolve('node_modules/.bin/electron'),['scripts/verify-workbench-native.mjs',preview.previewUrl,fixture.info.dataDir,output,fixture.info.url,pageURL],{env,stdio:'inherit'});
 const code=await new Promise(resolve=>child.on('exit',resolve));
 if(code!==0)throw new Error(`native fixture exit ${code}`);
}finally{page?.close();await preview?.close();if(managed)await waitForExit(managed,{signal:'SIGTERM'});await fixture.close();}
