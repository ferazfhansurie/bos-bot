import {app,BrowserWindow} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const [url,data,output]=process.argv.slice(2);
app.setPath('userData',path.join(data,'voice-electron'));app.dock?.hide();
app.whenReady().then(async () => {
const win=new BrowserWindow({show:false,width:1280,height:800,webPreferences:{contextIsolation:true,backgroundThrottling:false}});
const evaluate=code=>win.webContents.executeJavaScript(code,true);
const until=async(code,label)=>{for(let i=0;i<150;i++){if(await evaluate(code))return;await new Promise(r=>setTimeout(r,100));}throw new Error(label);};
const click=label=>evaluate(`document.querySelector('[aria-label=${JSON.stringify(label)}]')?.click()`);
const input=text=>evaluate(`(()=>{const e=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
const capture=async name=>{await new Promise(r=>setTimeout(r,250));fs.writeFileSync(path.join(output,name),(await win.webContents.capturePage()).toPNG());};
try{
fs.mkdirSync(output,{recursive:true});await win.loadURL(url);await until(`Boolean(document.querySelector('[aria-label="Start dictation"]'))`,'composer mic');
await capture('composer-compact.png');
await input('original draft');await evaluate(`document.querySelector('textarea').focus()`);
// Start dictation remains visible with a draft so words can be appended.
await click('Start dictation');await until(`Boolean(document.querySelector('[aria-label="Voice input"]'))`,'voice bar');
await evaluate(`window.__dictationFixture.emit('spoken words')`);await until(`document.querySelector('textarea').value==='original draft spoken words'`,'partial transcript');
await capture('composer-recording.png');await click('Cancel voice input');await until(`document.querySelector('textarea').value==='original draft'&&!document.querySelector('[aria-label="Voice input"]')`,'cancel restores draft');
await click('Start dictation');await until(`Boolean(document.querySelector('[aria-label="Voice input"]'))`,'restart voice');await evaluate(`window.__dictationFixture.emit('kept words')`);await click('Stop voice input');await until(`document.querySelector('textarea').value==='original draft kept words final'&&!document.querySelector('[aria-label="Voice input"]')`,'stop keeps final transcript');
assert.ok(await evaluate('window.__dictationFixture.stopped()>=2'));
await input('');await click('Start dictation');await until(`Boolean(document.querySelector('[aria-label="Voice input"]'))`,'send voice');await evaluate(`window.__dictationFixture.emit('send these words')`);await click('Send voice transcript');await until(`document.querySelector('[role="log"]').innerText.includes('send these words final')`,'send uses final transcript');
win.setContentSize(390,700);await new Promise(r=>setTimeout(r,300));assert.ok(await evaluate('document.documentElement.scrollWidth<=window.innerWidth'));await capture('composer-narrow.png');
fs.writeFileSync(path.join(output,'voice-verification.json'),JSON.stringify({syntheticSpeech:true,realMicrophone:false,cancelRestoresDraft:true,stopKeepsFinal:true,sendWaitsForFinal:true,narrowNoOverflow:true},null,2));console.log('voice composer fixture passed');win.destroy();app.exit(0);
}catch(error){console.error(error);await capture('failure.png');win.destroy();app.exit(1);}

});
