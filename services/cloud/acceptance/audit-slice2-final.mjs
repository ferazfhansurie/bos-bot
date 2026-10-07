import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,readdirSync,statSync} from 'node:fs';
import {createHash} from 'node:crypto';
const [prior,resumed,firstResume,nativeRoot]=process.argv.slice(2);
const read=p=>JSON.parse(readFileSync(p,'utf8'));
const journal=p=>readFileSync(p,'utf8').trim().split('\n').map(JSON.parse);
const races=[];
function audit(path,names,orders=['first-before-second','second-before-first']){const items=journal(path).filter(x=>x.type==='race');assert.equal(items.length,names.length*200);for(const name of names)for(const order of orders)for(let i=0;i<100;i++){const hits=items.filter(x=>x.name===name&&x.order===order&&x.iteration===i);assert.equal(hits.length,1,`${name}/${order}/${i}`);assert.equal(hits[0].state,'passed');}races.push(...items);}
const actions=['message.send','read','replay','snapshot.page','http.publication','realtime.publication'];
audit(prior+'/security/raw.jsonl',actions.map(x=>'a13-member-'+x));
audit(resumed+'/guest/raw.jsonl',actions.map(x=>'a13-guest-'+x));
audit(resumed+'/invites/raw.jsonl',['a16-redeem-revoke','a16-double-redeem']);
audit(resumed+'/expiry/raw.jsonl',['a16-invite-expiry'],['admission-before-expiry','expiry-before-admission']);
audit(firstResume+'/owner-orphan/raw.jsonl',['a16-mutual-owner-removal']);
for(const dir of ['guest','invites','expiry'])assert.ok(read(resumed+'/'+dir+'/summary.json').results.every(x=>x.state==='passed'));
assert.ok(read(firstResume+'/owner-orphan/summary.json').results.every(x=>x.state==='passed'));
const issuer=read(prior+'/issuer-final/summary.json'),tenancy=read(prior+'/tenancy/summary.json');
assert.equal(issuer.results.length,5);assert.ok(issuer.results.every(x=>x.state==='passed'));assert.ok(tenancy.results.every(x=>x.state==='passed'));
for(const x of issuer.results.filter(x=>x.stream_cutoff_ms!==undefined))assert.ok(x.stream_cutoff_ms<=15000);
const web=read(prior+'/web-states.json');assert.ok(web.unavailable.composerPresent && !web.unavailable.emailPresent);assert.equal(web.unavailable.subject,web.recovered.subject);assert.ok(web.recovered.text.includes('live'));assert.ok(web.revoked.emailPresent && !web.revoked.composerPresent);
const log=readFileSync(nativeRoot+'/native.private.log','utf8');assert.match(log,/\*\* TEST EXECUTE FAILED \*\*/);
const nativeResult=read(nativeRoot+'/native-summary.json');assert.equal(nativeResult.totalTestCount,1);assert.equal(nativeResult.failedTests,1);assert.equal(nativeResult.passedTests,0);
const native=[...log.matchAll(/CLOUD_INTEROP (\{[^\n]+\})/g)].map(x=>JSON.parse(x[1]));
assert.deepEqual(native.map(x=>x.event),['signedOutState','signOutRendered','unavailableState','issuerRecovered','revokedState']);
assert.equal(native.find(x=>x.event==='unavailableState').accountPreserved,'true');assert.equal(native.find(x=>x.event==='revokedState').roomRemoved,'true');
const nativeWire=journal(nativeRoot+'/fault-target.private.json.wire.jsonl');
for(const path of ['/api/auth/email-otp/send-verification-otp','/api/auth/sign-in/email-otp','/api/auth/sign-out'])assert.ok(nativeWire.some(x=>x.path===path&&x.status===200&&x.has_origin===false&&x.fetch_mode===null),'native request metadata/status: '+path);
const serviceJobs=read(resumed+'/job-results.json');
assert.deepEqual(serviceJobs.filter(x=>x.name!=='native').map(x=>x.name).sort(),['expiry','guest','invites']);
assert.ok(serviceJobs.filter(x=>x.name!=='native').every(x=>x.code===0));
assert.ok(read(nativeRoot+'/job-results.json').every(x=>x.name==='native'&&x.code===65));
const cleanup=read(resumed+'/cleanup.json');assert.equal(cleanup.owned_children_remaining,0);assert.equal(cleanup.state_removed,true);
const nativeCleanup=read(nativeRoot+'/cleanup.json');assert.equal(nativeCleanup.owned_children_remaining,0);assert.equal(nativeCleanup.state_removed,true);
const swift=readFileSync(firstResume+'/swift-tests.log','utf8');assert.match(swift,/Executed 31 tests, with 0 failures/);
assert.match(readFileSync(resumed+'/native-build-last.log','utf8'),/\*\* TEST BUILD SUCCEEDED \*\*/);
const hashes={};
for(const [root,dirs] of [[prior,['security','issuer-final','tenancy']],[resumed,['guest','invites','expiry']],[firstResume,['owner-orphan']]])for(const dir of dirs){
 let files;try{files=readdirSync(root+'/'+dir);}catch{continue;}
 for(const name of files){const f=root+'/'+dir+'/'+name;if(statSync(f).isFile()&&(/manifest\.json$|oracle\.jsonl$|raw\.jsonl$|summary\.json$/.test(name)))hashes[f]=createHash('sha256').update(readFileSync(f)).digest('hex');}
}
for(const f of [prior+'/web-states.json',nativeRoot+'/native.private.log',nativeRoot+'/native-summary.json',nativeRoot+'/fault-target.private.json.wire.jsonl',nativeRoot+'/job-results.json',nativeRoot+'/cleanup.json',resumed+'/job-results.json',resumed+'/cleanup.json',firstResume+'/swift-tests.log',resumed+'/native-build-last.log',nativeRoot+'/attachments/4D6A189E-FB10-4523-86EE-9B68BFDCACF0.png',nativeRoot+'/attachments/E6F345CE-D783-4A81-8D78-85F93AD65BF2.png'])hashes[f]=createHash('sha256').update(readFileSync(f)).digest('hex');
writeFileSync(resumed+'/evidence-hashes.json',JSON.stringify(hashes,null,2)+'\n',{flag:'wx',mode:0o600});
const summary={candidate:'fefeafa7981d9d1c9fad2aa03688a2d5e704affe',state:'blocked_native',server_state:'passed',races:races.length,member_removal:1200,guest_removal:1200,invite_revoke_double_redemption:400,invite_expiry:200,mutual_owner_removal:200,issuer:issuer.results,tenancy:tenancy.results,native:{result:nativeResult.result,failed_tests:1,passed_tests:0,exit_code:65,observations:native,warning:'logs after a failed XCTest assertion do not establish passing results',blocker:'revocation clears room but leaves a blank warning navigation destination; revoked sign-in is not visible'},web_states:'passed',cleanup,nativeCleanup,hashed_files:Object.keys(hashes).length,remaining_gates:['native revoked-state fix and independent rerun','ship integration and full suites','promotion and guarded installation','installed desktop acceptance','physical phone acceptance']};
writeFileSync(resumed+'/final-summary.json',JSON.stringify(summary,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({server_state:'passed',state:summary.state,races:races.length,native_failed_tests:1,hashed_files:summary.hashed_files}));
