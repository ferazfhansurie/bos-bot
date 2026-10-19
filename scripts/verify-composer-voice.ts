import {launchVerificationServer,runControlOmb} from './control-omb.ts';
import {mountPreview} from './testing/preview-fixture.ts';
import {spawn} from 'node:child_process';
import path from 'node:path';
const fixture=await launchVerificationServer();let ui;
try{await runControlOmb(['new-bot','--name','bos','--url',fixture.info.url]);ui=await mountPreview(fixture,{entry:'/scripts/testing/composer-voice-preview.tsx',route:'/__composer-voice.html',title:'Synthetic voice composer',logLevel:'error'});const {ELECTRON_RUN_AS_NODE:_node,...env}=process.env;const child=spawn(path.resolve('node_modules/.bin/electron'),['scripts/verify-composer-voice-native.mjs',ui.previewUrl,fixture.info.dataDir,process.argv[2]??'.omb-scratch/composer-voice'],{env,stdio:'inherit'});if(await new Promise(resolve=>child.on('exit',resolve))!==0)throw new Error('voice fixture failed');}finally{await ui?.close();await fixture.close();}
