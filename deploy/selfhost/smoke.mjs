// Disposable compose project only. Reads log-delivery OTPs into memory; never
// prints OTPs, bearer tokens or resolved environment. No real users or bot turns.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
const project = process.argv[2];
if (!project?.startsWith('bos-20-rehearsal-')) throw new Error('requires explicitly named disposable rehearsal project');
const container = service => `${project}-${service}-1`;
function docker(args, input) {
  const p = spawnSync('docker', args, { input, encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (p.status !== 0) throw new Error('docker smoke command failed (output withheld)');
  return p.stdout;
}
function call(service, path, method = 'GET', body, token) {
  const port = service === 'issuer' ? 8787 : 8790;
  const input = JSON.stringify({url:`http://${service}:${port}${path}`,method,body,token});
  const script = `let input='';for await(const c of process.stdin)input+=c;const x=JSON.parse(input);const r=await fetch(x.url,{method:x.method,headers:{'content-type':'application/json',origin:process.env.CLOUD_SERVICE_URL,...(x.token?{authorization:'Bearer '+x.token}:{})},body:x.body===undefined?undefined:JSON.stringify(x.body)});console.log(JSON.stringify({status:r.status,token:r.headers.get('set-auth-token'),body:await r.json()}));`;
  return JSON.parse(docker(['exec','-i',container('room'),'node','--input-type=module','-e',script],input));
}
function ok(service,path,method,body,token) {
  const r=call(service,path,method,body,token);
  assert.ok(r.status>=200 && r.status<300, `${service} ${path}: ${r.status} ${r.body.error ?? ''}`);
  return r;
}
function signIn(email) {
  ok('issuer','/api/auth/email-otp/send-verification-otp','POST',{email,type:'sign-in'});
  const codes = docker(['logs',container('issuer')]).split('\n').flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
  const code = codes.filter(c=>c.otp_delivery && c.email===email).at(-1)?.otp;
  assert.ok(code,'private OTP delivery missing');
  const signed = ok('issuer','/api/auth/sign-in/email-otp','POST',{email,otp:code});
  assert.ok(signed.token,'signed bearer missing');
  return signed.token;
}
const suffix=randomBytes(5).toString('hex');
const a=signIn(`alice-${suffix}@pilot.example`), b=signIn(`bob-${suffix}@pilot.example`);
const ai=ok('room','/v2/me','GET',undefined,a).body, bi=ok('room','/v2/me','GET',undefined,b).body;
assert.notEqual(ai.subject,bi.subject);
const w=ok('room','/v2/workspaces','POST',{name:'disposable selfhost smoke'},a).body.workspace_id;
const r=ok('room',`/v2/workspaces/${w}/rooms`,'POST',{name:'two humans'},a).body;
const invite=ok('room',`/v2/workspaces/${w}/invites`,'POST',{role:'member',room_ids:[r.room_id]},a).body;
ok('room','/v2/invites/redeem','POST',{token:invite.token},b);
for (const [token,text] of [[a,'fictional alice'],[b,'fictional bob']]) {
  const win=ok('room',`/v2/workspaces/${w}/operation-windows`,'POST',{},token).body;
  const snap=ok('room',`/v2/workspaces/${w}/rooms/${r.room_id}/snapshot`,'POST',{thread_id:r.thread_id},token).body;
  const sent=ok('room',`/v2/workspaces/${w}/messages`,'POST',{
    kind:'message.send',namespace:win.namespace,window_token:win.window_token,
    client_operation_id:win.window_id+'.'+randomBytes(18).toString('base64url'),
    room_id:r.room_id,thread_id:r.thread_id,text,mentions:[],attachment_ids:[],
    reply_to_message_id:null,expected_policy_revision:snap.policy_revision,
  },token).body;
  assert.equal(sent.status,'accepted');
}
const history=ok('room',`/v2/workspaces/${w}/rooms/${r.room_id}/history?thread_id=${r.thread_id}`,'GET',undefined,b).body;
assert.deepEqual(history.messages.map(m=>m.text),['fictional alice','fictional bob']);
ok('issuer','/api/auth/sign-out','POST',{},a);
assert.equal(call('room','/v2/me','GET',undefined,a).status,401);
assert.equal(call('room','/v2/test/sign-in','POST',{}).status,404);
console.log(JSON.stringify({passed:true,scope:'disposable compose HTTP smoke',privateIssuer:true,humans:2,inviteRedeemed:true,messages:2,revoked:true,fixtureRouteAbsent:true,uiVerified:false,tlsVerified:false}));
