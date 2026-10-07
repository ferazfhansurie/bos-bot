import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CloudService } from './service.ts';
import { CloudError } from './identity.ts';
import { ATTACHMENT_LIMITS, IdSchema } from '../../shared/cloud-protocol/index.ts';
/** Additional protected local endpoints. No credentials are placed in URL except scoped upload token. */
export async function runtimeRoute(s: CloudService, req: IncomingMessage, res: ServerResponse, path: string[], url: URL, token: string, body: (req: IncomingMessage) => Promise<any>, write: (res: ServerResponse, value: unknown, status?: number) => void) {
    if (path[1] !== 'workspaces' || !path[2])
        return false;
    const w = IdSchema.parse(path[2]), method = req.method;
    let value: any, room: string | undefined, host: string | undefined;
    const credential = typeof req.headers['x-cloud-host-credential'] === 'string' ? req.headers['x-cloud-host-credential'] : '';
    if (path[3] === 'push-registrations' && path.length === 4 && method === 'POST')
        value = await s.push.renew(token, w, await body(req));
    else if (path[3] === 'push-registrations' && path.length === 5 && method === 'DELETE')
        value = await s.push.revoke(token, w, IdSchema.parse(path[4]));
    else if (path[3] === 'bots' && path.length === 4 && method === 'POST')
        value = await s.runtime.registerBot(token, w, await body(req));
    else if (path[3] === 'hosts') {
        if (path.length === 4 && method === 'POST')
            value = await s.runtime.registerHost(token, w, await body(req));
        else if (path.length === 5 && method === 'DELETE')
            value = await s.runtime.revokeHost(token, w, IdSchema.parse(path[4]));
        else if (path.length === 6) {
            host = IdSchema.parse(path[4]);
            if (path[5] === 'invocations' && method === 'GET')
                value = await s.runtime.offers(token, w, host, credential);
            else if (path[5] === 'claim' && method === 'POST')
                value = await s.runtime.claim(token, w, host, credential, await body(req));
            else if (path[5] === 'heartbeat' && method === 'POST')
                value = await s.runtime.heartbeat(token, w, host, credential, await body(req));
            else if (path[5] === 'events' && method === 'POST')
                value = await s.runtime.append(token, w, host, credential, await body(req));
            else if (path[5] === 'context' && method === 'POST')
                value = await s.runtime.context(token, w, host, credential, await body(req));
            else
                throw new CloudError('not_found', 404);
            room = value.room_id;
        }
        else
            throw new CloudError('not_found', 404);
    }
    else if (path[3] === 'rooms' && path[4] && path[5] === 'invocations' && path.length === 8 && method === 'POST' && ['stop', 'resume'].includes(path[7])) {
        room = IdSchema.parse(path[4]);
        value = await s.runtime.control(token, w, room, IdSchema.parse(path[6]), await body(req), path[7] === 'resume');
    }
    else if (path[3] === 'rooms' && path[4] && path[5] === 'approvals' && ((path.length === 7 && method === 'GET') || (path.length === 8 && path[7] === 'decision' && method === 'POST'))) {
        room = IdSchema.parse(path[4]);
        value = await s.runtime.approval(token, w, room, IdSchema.parse(path[6]), method === 'POST' ? await body(req) : undefined);
    }
    else if (path[3] === 'attachments') {
        if (path.length === 4 && method === 'POST') {
            value = await s.attachments.prepare(token, w, await body(req));
            room = value.attachment.room_id;
        }
        else if (path[4]) {
            const a = IdSchema.parse(path[4]);
            if (path.length === 5 && method === 'GET') {
                value = await s.attachments.metadata(token, w, a);
                room = value.room_id;
            }
            else if (path.length === 6 && path[5] === 'upload' && method === 'PUT') {
                // Admission before buffering, and again after bytes arrive. Bounded by raw byte ceiling.
                value = await s.attachments.limited(async () => {
                    await s.attachments.admitUpload(token,w,a,url.searchParams.get('token')??'');
                    let n = 0;
                    const chunks: Buffer[] = [];
                    for await (const chunk of req) {
                        n += chunk.length;
                        if (n > ATTACHMENT_LIMITS.bytes)
                            throw new CloudError('invalid_request', 413);
                        chunks.push(chunk);
                    }
                    return s.attachments.upload(token, w, a, url.searchParams.get('token') ?? '', Buffer.concat(chunks));
                });
                room = value.room_id;
            }
            else if (path.length === 6 && path[5] === 'complete' && method === 'POST') {
                value = await s.attachments.complete(token, w, a, await body(req));
                room = value.room_id;
            }
            else if (path.length === 6 && path[5] === 'download' && method === 'GET') {
                await s.attachments.download(token, w, a, req.headers.range, (bytes, v, start, end, partial) => {
                    if (res.destroyed || res.writableEnded)
                        return;
                    res.writeHead(partial ? 206 : 200, { 'Content-Type': v.type, 'Content-Length': bytes.length, 'Cache-Control': 'no-store', 'Content-Disposition': 'attachment', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'", 'Accept-Ranges': 'bytes', ...(partial ? { 'Content-Range': `bytes ${start}-${end}/${v.size}` } : {}) });
                    res.end(bytes);
                });
                return true;
            }
            else
                throw new CloudError('not_found', 404);
        }
        else
            throw new CloudError('not_found', 404);
    }
    else
        return false;
    await s.protect(token, w, room, 'runtime.publication', {}, async (q, i) => {
        if (host) {
            await s.runtime.host(q, w, host, i.account_id, credential);
            if (value.invocation_id) {
                const v = await s.runtime.row(q, w, value.invocation_id);
                if (!await s.runtime.granted(q, w, v.room_id, i.account_id) || !await s.runtime.authority(q, v))
                    throw new CloudError('forbidden');
            }
            if (value.invocations) {
                const current = [];
                for (const offered of value.invocations) {
                    const v = await s.runtime.row(q, w, offered.invocation_id);
                    if (await s.runtime.granted(q, w, v.room_id, i.account_id) && await s.runtime.authority(q, v))
                        current.push(s.runtime.run(v));
                }
                value = { invocations: current };
            }
        }
        write(res, value, value?.error ? 409 : 200);
    });
    return true;
}
