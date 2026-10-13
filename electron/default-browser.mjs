import path from 'node:path';import {execFile} from 'node:child_process';
const registrar='/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
export function registerBrowserApp({platform=process.platform,packaged=false,executable=process.execPath,run=execFile}={}) {
 if(platform!=='darwin'||!packaged)return Promise.resolve(false);
 const bundle=path.resolve(path.dirname(executable),'../..');
 if(!bundle.endsWith('.app'))return Promise.reject(new Error('Browser registration requires the installed app.'));
 return new Promise((resolve,reject)=>run(registrar,['-f',bundle],{timeout:15000},error=>error?reject(new Error('macOS could not register this browser.')):resolve(true)));
}
