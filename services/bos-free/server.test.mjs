import test from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let seen = [];
const up = http.createServer((req, res) => {
  if (req.url.endsWith('/models')) { res.setHeader('content-type','application/json'); return res.end(JSON.stringify({ data: [
    { id: 'a/free-one:free', pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] },
    { id: 'b/paid', pricing: { prompt: '0.001', completion: '0.002' }, supported_parameters: ['tools'] },
    { id: 'stealth/zero', pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] },
  ] })); }
  let b=''; req.on('data',c=>b+=c); req.on('end',()=>{ seen.push({ auth: req.headers.authorization, body: JSON.parse(b) }); res.setHeader('content-type','application/json'); res.end(JSON.stringify({ choices:[{message:{content:'hi'}}] })); });
});
await new Promise(r=>up.listen(0,'127.0.0.1',r));
const dir = fs.mkdtempSync(path.join(os.tmpdir(),'bosfree-'));
Object.assign(process.env,{ OPENROUTER_API_KEY:'sk-owner-secret', UPSTREAM:`http://127.0.0.1:${up.address().port}`, BOS_FREE_DATA: path.join(dir,'d.json'), PER_INSTALL_DAILY:'2', GLOBAL_DAILY:'3', REGISTER_PER_IP_DAILY:'2', CHAT_PER_IP_DAILY:'100' });
const { server } = await import('./server.mjs');
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base = `http://127.0.0.1:${server.address().port}/api/v1`;
const j = (r) => r.json();
const reg = () => fetch(`${base}/register`,{method:'POST'});
const chat = (t, body) => fetch(`${base}/chat/completions`,{method:'POST',headers:{authorization:`Bearer ${t}`,'content-type':'application/json'},body:JSON.stringify(body)});

test('relay', async () => {
  assert.equal((await fetch(`${base}/models`)).status, 401);
  const { token } = await j(await reg());
  const { token: t2 } = await j(await reg());
  assert.equal((await reg()).status, 429, 'register rate limit');
  const models = (await j(await fetch(`${base}/models`,{headers:{authorization:`Bearer ${token}`}}))).data.map(m=>m.id);
  assert.deepEqual(models, ['a/free-one:free'], 'only :free zero-price tool models');
  assert.equal((await chat(token,{model:'b/paid',messages:[]})).status, 400);
  assert.equal((await chat(token,{model:'stealth/zero',messages:[]})).status, 400);
  assert.equal(seen.length, 0, 'rejected models never reach upstream');
  assert.equal((await chat(token,{model:'a/free-one:free',messages:[{role:'user',content:[{type:'file',file:{file_data:'x'}}]}]})).status, 400, 'file parts rejected');
  assert.equal((await chat(token,{model:'a/free-one:free',messages:[{role:'user',content:[{type:'image_url',image_url:{url:'x'}}]}]})).status, 400, 'image parts rejected');
  assert.equal((await chat(token,{model:'a/free-one:free',messages:[],tools:[{type:'openrouter:web_search'}]})).status, 400, 'server tools rejected');
  assert.equal((await fetch(`${base}/chat/completions`,{method:'POST',headers:{authorization:`Bearer ${token}`},body:'null'})).status, 400, 'null body');
  assert.equal(seen.length, 0);
  const ok = await chat(token,{model:'a/free-one:free',messages:[{role:'user',content:[{type:'text',text:'x'}]}],tools:[{type:'function',function:{name:'f',parameters:{}}}],models:['b/paid'],plugins:[{id:'web'}],route:'fallback',max_tokens:99999,provider:{allow_fallbacks:true}});
  assert.equal(ok.status, 200);
  const sent = seen[0];
  assert.equal(sent.auth, 'Bearer sk-owner-secret');
  assert.equal(sent.body.models, undefined); assert.equal(sent.body.plugins, undefined); assert.equal(sent.body.route, undefined);
  assert.equal(sent.body.max_tokens, 4096);
  assert.equal(sent.body.provider.allow_fallbacks, false); assert.equal(sent.body.provider.max_price.completion, 0);
  const body = await ok.text(); assert(!body.includes('sk-owner-secret'));
  assert.equal((await chat(token,{model:'a/free-one:free',messages:[]})).status, 200);
  assert.equal((await chat(token,{model:'a/free-one:free',messages:[]})).status, 429, 'per-install cap');
  assert.equal((await chat(t2,{model:'a/free-one:free',messages:[]})).status, 200);
  assert.equal((await chat(t2,{model:'a/free-one:free',messages:[]})).status, 429, 'global cap');
  assert.equal((await chat('bosf_'+'x'.repeat(30),{model:'a/free-one:free',messages:[]})).status, 401);
  const stored = fs.readFileSync(path.join(dir,'d.json'),'utf8'); assert(!stored.includes(token), 'tokens stored hashed');
  server.close(); up.close();
});
