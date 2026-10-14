import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TelegramChannels, telegramCall, type TelegramCall, type TelegramUpdate } from './telegram-channels.ts';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'bos-tg-')); dirs.push(dir);
  const calls: { token: string; method: string; body: Record<string, unknown> }[] = [];
  let now = 1_000_000;
  const call: TelegramCall = async <T>(token: string, method: string, body: Record<string, unknown>) => {
    calls.push({ token, method, body });
    const result = method === 'getMe' ? { id: 900, is_bot: true, username: 'manager_bot' } : method === 'getWebhookInfo' ? { url: '' } : method === 'getManagedBotToken' ? 'child-secret' : method === 'getChatMember' ? {status:'administrator'} : { message_id: 99 };
    return result as T;
  };
  const hooks = { exists: () => true, run: async () => ({ text: 'answer' }) };
  const service = new TelegramChannels({ dataDir: dir, managerToken: 'manager-secret', hooks, call, now: () => now });
  return { dir, calls, service, hooks, call, now: () => now, advance: () => { now += 16 * 60_000; } };
}
function message(id: number, text: string, actor = 1, chat = actor): TelegramUpdate {
  return { update_id: id, message: { message_id: id, from: { id: actor }, chat: { id: chat, type: chat > 0 ? 'private' : 'supergroup' }, text } };
}
async function pair(f: ReturnType<typeof fixture>, botId = 'a', owner = 1) {
  const result = await f.service.connect(botId, 'test');
  await f.service.handleManager(message(1, `/start ${new URL(result.url).searchParams.get('start')}`, owner));
  const call = f.calls.findLast(c => c.method === 'sendMessage')!;
  const markup = call.body.reply_markup as {inline_keyboard: {url:string}[][]};
  const username = new URL(markup.inline_keyboard[0][0].url).pathname.split('/').at(-1)!;
  await f.service.handleManager({update_id:2, managed_bot: { user: {id: owner}, bot: {id: owner + 100, username, is_bot:true} }});
  return username;
}
describe('telegram managed channels', () => {
  it('requires server configuration and leaves existing bots untouched', async () => {
    const f = fixture(); const s = new TelegramChannels({dataDir:f.dir, hooks:f.hooks});
    await expect(s.connect('a','test')).rejects.toThrow('setup');
    expect(f.calls).toHaveLength(0);
  });
  it('binds creation to both verified creator and exact suggested username', async () => {
    const f = fixture(); const result = await f.service.connect('a','test');
    await f.service.handleManager(message(1, `/start ${new URL(result.url).searchParams.get('start')}`));
    const state = JSON.parse(readFileSync(join(f.dir,'telegram-channels.json'),'utf8'));
    const username = state.pending.a.username;
    await f.service.handleManager({update_id:2,managed_bot:{user:{id:2},bot:{id:101,username,is_bot:true}}});
    await f.service.handleManager({update_id:3,managed_bot:{user:{id:1},bot:{id:101,username:'wrong_bot',is_bot:true}}});
    expect(f.service.status('a').connection).toBeNull();
    await f.service.handleManager({update_id:4,managed_bot:{user:{id:1},bot:{id:101,username,is_bot:true}}});
    expect(f.service.status('a').connection?.username).toBe(username);
    const saved = readFileSync(join(f.dir,'telegram-channels.json'),'utf8');
    expect(saved).not.toContain('manager-secret'); expect(saved).not.toContain('child-secret');
    expect(saved).not.toContain(new URL(result.url).searchParams.get('start'));
  });
  it('expires setup and refuses anonymous senders', async () => {
    const f = fixture(); const url = (await f.service.connect('a','test')).url; f.advance();
    await f.service.handleManager(message(1, `/start ${new URL(url).searchParams.get('start')}`));
    expect(f.calls.filter(c=>c.method === 'sendMessage')).toHaveLength(0);
    await pair(f);
    await f.service.handleMessage('a',message(10,'not invited',2));
    const anonymous=message(11,'hello'); anonymous.message!.sender_chat={id:1};
    await f.service.handleMessage('a',anonymous);
    expect(JSON.parse(readFileSync(join(f.dir,'telegram-channels.json'),'utf8')).jobs).toHaveLength(0);
  });
  it('isolates groups, requires owner connection and accepts invited mentions once', async () => {
    const f = fixture(); const username=await pair(f);
    await f.service.handleMessage('a',message(10,`hi @${username}`,1,-4));
    await f.service.handleMessage('a',message(11,`/connect@${username}`,2,-4));
    expect(f.service.status('a').connection?.groups).toBe(0);
    await f.service.handleMessage('a',message(12,`/connect@${username}`,1,-4));
    await f.service.handleMessage('a',message(13,'unaddressed',1,-4));
    const u=message(14,`hi @${username}`,1,-4);
    await f.service.handleMessage('a',u); await f.service.handleMessage('a',u);
    const jobs=JSON.parse(readFileSync(join(f.dir,'telegram-channels.json'),'utf8')).jobs;
    expect(jobs).toHaveLength(1); expect(jobs[0].chatId).toBe(-4);
  });
  it('private invites are one-use and cannot be redeemed in a group', async () => {
    const f=fixture(); await pair(f); const invite=f.service.invite('a');
    const text=`/start ${new URL(invite.url).searchParams.get('start')}`;
    await f.service.handleMessage('a',message(3,text,2,-4));
    expect(f.service.status('a').connection?.members).toBe(1);
    await f.service.handleMessage('a',message(4,text,2));
    await f.service.handleMessage('a',message(5,text,3));
    expect(f.service.status('a').connection?.members).toBe(2);
  });
  it('ownership changes revoke access and disconnect retires queued work', async () => {
    const f=fixture(); const username=await pair(f);
    await f.service.handleMessage('a',message(10,'do work'));
    await f.service.handleManager({update_id:11,managed_bot:{user:{id:2},bot:{id:101,username,is_bot:true}}});
    expect(f.service.status('a').connection).toBeNull();
    expect(JSON.parse(readFileSync(join(f.dir,'telegram-channels.json'),'utf8')).jobs[0].phase).toBe('interrupted');
  });
  it('restart marks admitted work interrupted instead of running it twice', async () => {
    const f=fixture(); await pair(f); await f.service.handleMessage('a',message(10,'do work'));
    const path=join(f.dir,'telegram-channels.json'); const state=JSON.parse(readFileSync(path,'utf8'));
    state.jobs[0].phase='running'; writeFileSync(path,JSON.stringify(state));
    const restarted=new TelegramChannels({dataDir:f.dir, managerToken:'manager-secret',hooks:f.hooks,call:f.call});
    expect(restarted.status('a').interrupted).toBe(1);
    await restarted.handleMessage('a',message(10,'do work'));
    expect(JSON.parse(readFileSync(path,'utf8')).jobs).toHaveLength(1);
  });
  it('does not expose credentials in upstream errors', async () => {
    await expect(telegramCall('invalid secret\n', 'getMe', {})).rejects.not.toThrow('invalid secret');
  });
});

it('does not resurrect a cancelled connection after manager lookup', async () => {
  const f=fixture();
  let release!: () => void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const call: TelegramCall=async <T>(token:string,method:string,body:Record<string,unknown>) => { if(method==='getMe') await gate; return f.call<T>(token,method,body); };
  const service=new TelegramChannels({dataDir:f.dir,managerToken:'manager-secret',hooks:f.hooks,call});
  const connecting=service.connect('a','test'); service.disconnect('a'); release();
  await expect(connecting).rejects.toThrow('cancelled');
  expect(service.status('a').pending).toBe(false);
});

it('streams a long reply and sends its remainder without duplicate edits', async () => {
  const f=fixture(); await pair(f);
  await f.service.handleMessage('a',message(10,'work'));
  const calls: Array<{method:string;body:Record<string,unknown>}>=[];
  let finished=false;
  const call: TelegramCall=async <T>(token:string,method:string,body:Record<string,unknown>) => {
    calls.push({method,body});
    if(method==='getUpdates') return [] as T;
    return f.call<T>(token,method,body);
  };
  const text='x'.repeat(4500);
  const service=new TelegramChannels({dataDir:f.dir,managerToken:'manager-secret',call,hooks:{exists:()=>true,run:async (_job,_active,progress)=>{
    await progress(text); await progress(text+'tail'); finished=true; return {text:text+'tail'};
  }}});
  await service.start();
  try {
    await expect.poll(()=>finished,{timeout:3000}).toBe(true);
    await expect.poll(()=>JSON.parse(readFileSync(join(f.dir,'telegram-channels.json'),'utf8')).jobs[0].phase).toBe('done');
    expect(calls.filter(c=>c.method==='editMessageText')).toHaveLength(1);
    expect(calls.filter(c=>c.method==='sendMessage').at(-1)?.body.text).toBe('x'.repeat(500)+'tail');
  } finally { service.stop(); }
});

it('keeps conversation identity across restarts and separates chats and topics', async () => {
  const f=fixture(); await pair(f);
  f.service.rememberConversation('a',1,0,'private-thread');
  f.service.rememberConversation('a',-4,10,'group-topic-thread');
  const restarted=new TelegramChannels({dataDir:f.dir,managerToken:'manager-secret',hooks:f.hooks,call:f.call});
  expect(restarted.conversation('a',1)).toBe('private-thread');
  expect(restarted.conversation('a',-4,10)).toBe('group-topic-thread');
  expect(restarted.conversation('a',-4,11)).toBeUndefined();
  restarted.disconnect('a');
  expect(restarted.conversation('a',1)).toBeUndefined();
});
