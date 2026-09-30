import { expect, it } from 'vitest';
import { request as httpRequest } from 'node:http';
import { basename } from 'node:path';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { launchVerificationServer } from '../scripts/control-omb.ts';

it('independent privacy boundary: real attachment, room history, mentions, owner phone and delayed retry', async () => {
  const fixture = await launchVerificationServer({ FAKE_CLAUDE_TEXTS: JSON.stringify(['fixture public reply']), FAKE_CLAUDE_ROOM_PUSH_OUTBOX: 'privacy-push-outbox.jsonl' });
  const api = async (method: string, path: string, body?: any, token?: string) => {
    const response = await fetch(fixture.info.url + path, { method, headers: { 'content-type': 'application/json', origin: fixture.info.url, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  try {
    const bot = (await api('GET', '/api/bots')).body.bots[0];
    await api('PATCH', `/api/bots/${bot.id}`, { name: 'Privacyfixture' });
    const me = (await api('GET', '/api/multiplayer/me')).body;
    const contact = `${me.homeId}:bot:${bot.id}`;
    const avatarUpload = await fetch(fixture.info.url + '/api/attachments', {method:'POST',headers:{'content-type':'image/png'},body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII=','base64')});
    expect(avatarUpload.status).toBe(201);
    const avatar = '/api/attachments/' + basename((await avatarUpload.json() as any).path);
    expect((await api('PATCH', `/api/bots/${bot.id}`, {avatarUrl:avatar})).status).toBe(200);
    const pair = async (scope: string) => {
      const code = (await api('POST', '/api/auth/pairing', { scopes: [scope] })).body.code;
      return (await api('POST', '/api/auth/pair', { code, label: `fixture ${scope}` })).body;
    };
    const peer = await pair('peer'); const phone = await pair('client');
    expect((await api('POST', '/api/multiplayer/actor-bindings', { sessionId: phone.session.id, personId: me.actorId, name: 'Owner' })).status).toBe(200);
    const other = 'other-home:person:owner';
    expect((await api('POST', '/api/multiplayer/actor-bindings', { sessionId: peer.session.id, personId: other, name: 'Other' })).status).toBe(200);
    const task = (await api('POST', `/api/bots/${bot.id}/tasks`, { title: 'peer fixture' }, peer.token)).body.task;
    const attachmentBase = `/api/multiplayer/peer-threads/${task.threadId}/attachments`;
    const upload = await fetch(fixture.info.url + attachmentBase + '?name=sentinel.txt', { method: 'POST', headers: { authorization: `Bearer ${peer.token}`, 'content-type': 'text/plain' }, body: 'attachment sentinel' });
    expect(upload.status).toBe(201);
    const saved = await upload.json() as any;
    const attachmentPath = attachmentBase + '/' + basename(saved.path);
    expect(await (await fetch(fixture.info.url + attachmentPath, { headers: { authorization: `Bearer ${peer.token}` } })).text()).toBe('attachment sentinel');
    const room = (await api('POST', '/api/multiplayer/rooms', { name: 'fixture room', memberIds: [me.actorId, other] })).body.room;
    expect(room.id).toBeTruthy();
    expect((await api('PATCH', `/api/multiplayer/rooms/${room.id}/preferences`, { notifications: 'all' }, peer.token)).status).toBe(200);
    expect((await api('POST', `/api/multiplayer/rooms/${room.id}/messages`, { text: 'ordinary room note', sendId: 'ordinary-push' })).status).toBe(201);
    const pushOutbox = join(fixture.info.dataDir, 'privacy-push-outbox.jsonl');
    expect(readFileSync(pushOutbox, 'utf8')).toContain('ordinary room note');
    const message = { text: '@Privacyfixture fixture', sendId: 'privacy-retry', botTargets: [contact] };
    expect((await api('POST', `/api/multiplayer/rooms/${room.id}/messages`, message)).status).toBe(201);
    // Keep a request in readBody while privacy changes. No production connection.
    let finish!: () => void;
    const delayed = new Promise<{ status: number; body: any }>((resolve, reject) => {
      const bytes = JSON.stringify({ title: "must not create after private" });
      const req = httpRequest(fixture.info.url + `/api/bots/${bot.id}/tasks`, { method: 'POST', headers: { authorization: `Bearer ${peer.token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(bytes) } }, res => {
        let text = ''; res.on('data', chunk => text += chunk); res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(text) }));
      });
      req.on('error', reject); req.write(bytes.slice(0, -1)); finish = () => req.end(bytes.slice(-1));
    });
    await new Promise(resolve => setTimeout(resolve, 250));
    expect((await api('PATCH', `/api/bots/${bot.id}`, { visibility: 'private' })).status).toBe(200);
    const pushesBeforePrivateMessage = readFileSync(pushOutbox, 'utf8');
    expect((await api('POST', `/api/multiplayer/rooms/${room.id}/messages`, { text: '@Privacyfixture private note', sendId: 'private-push', botTargets: [contact] })).status).toBe(201);
    expect(readFileSync(pushOutbox, 'utf8')).toBe(pushesBeforePrivateMessage);
    finish();
    const raced = await delayed;
    expect((await fetch(fixture.info.url + avatar, {headers:{authorization:`Bearer ${peer.token}`}})).status).toBe(403);
    expect((await fetch(fixture.info.url + avatar, {headers:{authorization:`Bearer ${phone.token}`}})).status).toBe(200);
    for (const route of [attachmentPath, `/api/threads/${task.threadId}/messages`, `/api/multiplayer/rooms/${room.id}/messages`, `/api/multiplayer/rooms/${room.id}/bots`, `/api/multiplayer/rooms/${room.id}/files`, `/api/multiplayer/rooms/${room.id}/search?q=fixture`, `/api/multiplayer/rooms/${room.id}/requests`]) {
      expect((await fetch(fixture.info.url + route, { headers: { authorization: `Bearer ${peer.token}` } })).status, route).toBe(404);
    }
    expect((await api('GET', '/api/bots', undefined, phone.token)).body.bots.some((b: any) => b.id === bot.id)).toBe(true);
    expect((await api('GET', `/api/multiplayer/rooms/${room.id}/messages`, undefined, phone.token)).status).toBe(200);
    expect((await api('GET', '/api/multiplayer/rooms', undefined, peer.token)).body.rooms.some((r: any) => r.id === room.id)).toBe(false);
    const cleanRoom = (await api('POST', '/api/multiplayer/rooms', { name: 'new room', memberIds: [me.actorId, other] })).body.room;
    expect((await api('POST', `/api/multiplayer/rooms/${cleanRoom.id}/messages`, { ...message, sendId: 'new-private-mention' }, peer.token)).status).toBe(403);
    console.log('independent boundary evidence', JSON.stringify({ savedAttachmentBlocked: true, roomHistoryBlocked: true, explicitMentionBlocked: true, ownerPhoneRetained: true, delayedRetry: raced }));
    expect(raced.status, 'a request begun before privacy change must not create a private bot task after the change').toBe(404);
    const afterRace = (await api('GET', '/api/bots')).body.bots.find((entry: any) => entry.id === bot.id);
    expect(afterRace.tasks.some((entry: any) => entry.title === 'must not create after private')).toBe(false);
  } finally { await fixture.close(); }
}, 60_000);
