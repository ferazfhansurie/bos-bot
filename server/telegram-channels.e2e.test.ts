import { expect, it } from 'vitest';
import { compatEnv } from '../electron/branding-env.cjs';
import { launchVerificationServer, runControlOmb } from '../scripts/control-omb.ts';

it('exposes native channel setup in an isolated server and fails closed without a manager', async () => {
  const fixture = await launchVerificationServer({ ...compatEnv });
  try {
    const result = await runControlOmb(['new-bot', '--name', 'Channel fixture', '--url', fixture.info.url]) as {bot:{id:string}};
    const path = `${fixture.info.url}/api/bots/${result.bot.id}/telegram-channel`;
    const response = await fetch(path);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({configured:false,connection:null,pending:false});
    const connect = await fetch(`${path}/connect`,{method:'POST'});
    expect(connect.status).toBe(409);
    expect(await connect.json()).toMatchObject({error:'telegram setup is needed on this server'});
    const disconnected = await fetch(path,{method:'DELETE'});
    expect(disconnected.status).toBe(200);
    expect(await disconnected.json()).toMatchObject({connection:null});
    const unknown = await fetch(`${fixture.info.url}/api/bots/no-such-bot/telegram-channel`);
    expect(unknown.status).toBe(404);
  } finally { await fixture.close(); }
}, 60_000);
