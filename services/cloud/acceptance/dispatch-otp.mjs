import {readFileSync,writeFileSync,unlinkSync} from 'node:fs';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
// Better Auth counts dispatches until a full window of inactivity, rather
// than expiring individual sends. Hold the fixture-wide lock through the
// actual dispatch so delayed UI input cannot consume another reserved slot.
export async function dispatchOTP(statePath,send) {
 const lock=statePath+'.otp-dispatch.lock',schedule=statePath+'.otp-dispatch.json';
 const deadline=Date.now()+300000;
 for(;;){try{writeFileSync(lock,'',{flag:'wx',mode:0o600});break;}catch(e){if(e.code!=='EEXIST')throw e;if(Date.now()>deadline)throw new Error('otp dispatcher lock deadline');await pause(50);}}
 try {
  let previous={count:0,last:0};try{previous=JSON.parse(readFileSync(schedule));}catch(e){if(e.code!=='ENOENT')throw e;}
  if(previous.count>=5)while(Date.now()<previous.last+61000)await pause(Math.min(1000,previous.last+61000-Date.now()));
  if(Date.now()-previous.last>=61000)previous.count=0;
  const result=await send();
  writeFileSync(schedule,JSON.stringify({count:previous.count+1,last:Date.now()}),{mode:0o600});
  return result;
 }finally{unlinkSync(lock);}
}
