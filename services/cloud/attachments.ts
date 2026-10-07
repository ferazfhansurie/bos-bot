import { randomBytes, createHash } from 'node:crypto';
import { z } from 'zod';
import type { CloudService } from './service.ts';
import type { Sql } from './db.ts';
import { CloudError } from './identity.ts';
import { AttachmentPrepareSchema, AttachmentSchema, attachmentObjectKey, ATTACHMENT_LIMITS } from '../../shared/cloud-protocol/index.ts';
import { LocalObjects } from './objects.ts';
const id = () => randomBytes(18).toString('base64url');
export class Attachments {
    s: CloudService;
    store?: LocalObjects;
    bufferOperations = 0;
    async limited<T>(fn: () => Promise<T>): Promise<T> { if (this.bufferOperations >= 4)
        throw new CloudError('rate_limited', 429); this.bufferOperations++; try {
        return await fn();
    }
    finally {
        this.bufferOperations--;
    } }
    constructor(s: CloudService) { this.s = s; }
    value(v: any) { return AttachmentSchema.parse({ attachment_id: v.attachment_id, workspace_id: v.workspace_id, room_id: v.room_id, thread_id: v.thread_id, owner_id: v.owner_id, object_key: v.object_key, name: v.name, size: Number(v.size), type: v.type, checksum: v.checksum, state: v.state, expires_at: v.expires_at.toISOString() }); }
    async row(q: Sql, w: string, a: string) { const v = (await q.query('SELECT * FROM cloud.attachment_objects WHERE workspace_id=$1 AND attachment_id=$2 FOR UPDATE', [w, a])).rows[0]; if (!v)
        throw new CloudError('forbidden'); return v; }
    async prepare(token: string, w: string, body: unknown) {
        const b = AttachmentPrepareSchema.parse(body);
        if (!this.store)
            throw new CloudError('unavailable', 503);
        return this.s.protect(token, w, b.room_id, 'attachment.prepare', {}, async (q, i) => {
            await this.s.thread(q, w, b.room_id, b.thread_id);
            const a = id(), object_key = attachmentObjectKey(w, b.room_id, a);
            const v = (await q.query("INSERT INTO cloud.attachment_objects(workspace_id,room_id,thread_id,attachment_id,owner_id,object_key,name,size,type,checksum,state,expires_at,upload_expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'preparing',clock_timestamp()+interval '24 hours',clock_timestamp()+interval '5 minutes') RETURNING *", [w, b.room_id, b.thread_id, a, i.account_id, object_key, b.name, b.size, b.type, b.checksum])).rows[0];
            const upload = this.s.sign({ kind: 'upload', service: this.s.service, workspace_id: w, attachment_id: a, account_id: i.account_id, expires_at: v.upload_expires_at.toISOString() });
            return { attachment: this.value(v), upload_url: this.s.service + `/v2/workspaces/${w}/attachments/${a}/upload?token=` + encodeURIComponent(upload), expires_at: v.upload_expires_at.toISOString() };
        });
    }
    async scoped<T>(token: string, w: string, a: string, action: string, fn: (q: Sql, v: any, i: any) => Promise<T>) {
        const i = await this.s.identify(token);
        const room = await this.s.db.tx(i.account_id, w, async (q) => (await this.row(q, w, a)).room_id);
        return this.s.protect(token, w, room, action, {}, async (q, i) => fn(q, await this.row(q, w, a), i));
    }
    async admitUpload(token: string, w: string, a: string, urlToken: string) {
        return this.scoped(token,w,a,'attachment.upload-admission',async(_q,v,i)=>{
            let signed;try{signed=this.s.verify(urlToken,'upload');}catch{throw new CloudError('forbidden');}
            if(v.owner_id!==i.account_id||signed.account_id!==i.account_id||signed.workspace_id!==w||signed.attachment_id!==a||Date.parse(signed.expires_at)<=Date.now()||v.upload_expires_at.getTime()<=Date.now()||v.expires_at.getTime()<=Date.now()||!['preparing','uploading','ready'].includes(v.state))throw new CloudError('forbidden');
            return this.value(v);
        });
    }
    async upload(token: string, w: string, a: string, urlToken: string, bytes: Buffer) {
        if (!this.store)
            throw new CloudError('unavailable', 503);
        return this.scoped(token, w, a, 'attachment.upload', async (q, v, i) => {
            let signed;
            try {
                signed = this.s.verify(urlToken, 'upload');
            }
            catch {
                throw new CloudError('forbidden');
            }
            if (v.owner_id !== i.account_id || signed.account_id !== i.account_id || signed.workspace_id !== w || signed.attachment_id !== a || Date.parse(signed.expires_at) <= Date.now() || v.upload_expires_at.getTime() <= Date.now() || v.expires_at.getTime() <= Date.now())
                throw new CloudError('forbidden');
            if (bytes.length !== Number(v.size) || bytes.length > ATTACHMENT_LIMITS.bytes || createHash('sha256').update(bytes).digest('hex') !== v.checksum)
                throw new CloudError('attachment_rejected', 400);
            if (v.state === 'ready')
                return this.value(v);
            if (!['preparing', 'uploading'].includes(v.state))
                throw new CloudError('attachment_rejected', 409);
            // Immutable bytes make retries/crash between fs write and DB commit harmless.
            try {
                await this.store!.put(v.object_key, bytes);
            }
            catch (e) {
                if ((e as any).code !== 'EEXIST')
                    throw e;
                const existing = await this.store!.get(v.object_key);
                if (!existing.equals(bytes))
                    throw new CloudError('operation_conflict', 409);
            }
            v = (await q.query("UPDATE cloud.attachment_objects SET state='uploading' WHERE workspace_id=$1 AND attachment_id=$2 RETURNING *", [w, a])).rows[0];
            return this.value(v);
        });
    }
    async complete(token: string, w: string, a: string, body: unknown) { return this.limited(() => this.completeWithin(token, w, a, body)); }
    async completeWithin(token: string, w: string, a: string, body: unknown) {
        z.object({}).strict().parse(body);
        if (!this.store)
            throw new CloudError('unavailable', 503);
        // Commit verifying first; scanner error/crash keeps the object quarantined.
        const v = await this.scoped(token, w, a, 'attachment.verifying', async (q, v, i) => {
            if (v.owner_id !== i.account_id)
                throw new CloudError('forbidden');
            if (v.state === 'ready' || v.state === 'rejected')
                return v;
            if (!['uploading', 'verifying'].includes(v.state) || v.expires_at.getTime() <= Date.now())
                throw new CloudError('attachment_unready', 409);
            return (await q.query("UPDATE cloud.attachment_objects SET state='verifying' WHERE workspace_id=$1 AND attachment_id=$2 RETURNING *", [w, a])).rows[0];
        });
        if (['ready', 'rejected'].includes(v.state))
            return this.value(v);
        const bytes = await this.store.get(v.object_key);
        let clean = false;
        try {
            clean = bytes.length === Number(v.size) && createHash('sha256').update(bytes).digest('hex') === v.checksum && await this.store.scan(bytes, v.type) === 'clean';
        }
        catch {
            throw new CloudError('unavailable', 503);
        }
        return this.scoped(token, w, a, 'attachment.complete', async (q, current, i) => {
            if (current.owner_id !== i.account_id || current.expires_at.getTime() <= Date.now())
                throw new CloudError('forbidden');
            if (current.state === 'verifying')
                current = (await q.query('UPDATE cloud.attachment_objects SET state=$3 WHERE workspace_id=$1 AND attachment_id=$2 RETURNING *', [w, a, clean ? 'ready' : 'rejected'])).rows[0];
            if (!['ready', 'rejected'].includes(current.state))
                throw new CloudError('attachment_unready', 409);
            await this.s.event(q, w, current.room_id, current.thread_id, 'attachment.updated', { actor_id: current.owner_id, attachment: this.value(current) });
            return this.value(current);
        });
    }
    async access(q: Sql, v: any, i: any) {
        if (v.owner_id === i.account_id)
            return;
        // Allocation alone never makes an orphan visible to recipients.
        if (v.state !== 'ready' || !(await q.query('SELECT 1 FROM cloud.message_attachments a JOIN cloud.messages m USING(workspace_id,room_id,message_id) WHERE a.workspace_id=$1 AND a.attachment_id=$2 AND NOT m.deleted', [v.workspace_id, v.attachment_id])).rowCount)
            throw new CloudError('forbidden');
    }
    async metadata(token: string, w: string, a: string) { return this.scoped(token, w, a, 'attachment.metadata', async (q, v, i) => { await this.access(q, v, i); return this.value(v); }); }
    async download(token: string, w: string, a: string, range: string | undefined, deliver: (bytes: Buffer, v: any, start: number, end: number, partial: boolean) => void) { return this.limited(() => this.downloadWithin(token, w, a, range, deliver)); }
    async downloadWithin(token: string, w: string, a: string, range: string | undefined, deliver: (bytes: Buffer, v: any, start: number, end: number, partial: boolean) => void) {
        if (!this.store)
            throw new CloudError('unavailable', 503);
        return this.scoped(token, w, a, 'attachment.download', async (q, v, i) => {
            await this.access(q, v, i);
            if (v.state !== 'ready' || (!v.attached && v.expires_at.getTime() <= Date.now()))
                throw new CloudError('attachment_unready', 409);
            const bytes = await this.store!.get(v.object_key);
            let start = 0, end = bytes.length - 1;
            if (range) {
                const m = /^bytes=(\d*)-(\d*)$/.exec(range);
                if (!m || (!m[1] && !m[2]))
                    throw new CloudError('invalid_request', 416);
                if (!m[1]) {
                    const n = Number(m[2]);
                    if (!Number.isSafeInteger(n) || n <= 0)
                        throw new CloudError('invalid_request', 416);
                    start = Math.max(0, bytes.length - n);
                }
                else {
                    start = Number(m[1]);
                    if (m[2])
                        end = Math.min(end, Number(m[2]));
                }
                if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= bytes.length)
                    throw new CloudError('invalid_request', 416);
            }
            // Identity/authority lock is retained through the actual response publication.
            this.s.fresh(i);
            deliver(bytes.subarray(start, end + 1), v, start, end, !!range);
        });
    }
    async attach(q: Sql, w: string, r: string, m: string, ids: string[]) { for (const a of new Set(ids)) {
        await q.query('INSERT INTO cloud.message_attachments VALUES($1,$2,$3,$4)', [w, r, m, a]);
        await q.query('UPDATE cloud.attachment_objects SET attached=true WHERE workspace_id=$1 AND attachment_id=$2', [w, a]);
    } }
    async expire(q: Sql, w: string) {
        const rows = (await q.query("UPDATE cloud.attachment_objects SET state='expired' WHERE workspace_id=$1 AND NOT attached AND expires_at<=clock_timestamp() AND state<>'expired' RETURNING object_key", [w])).rows;
        // No expiry touches an attached object. An fs deletion failure retries on later sweep.
        for (const v of rows)
            await this.store?.remove(v.object_key);
        for (const v of (await q.query("SELECT object_key FROM cloud.attachment_objects WHERE workspace_id=$1 AND state='expired' AND NOT attached", [w])).rows)
            await this.store?.remove(v.object_key);
    }
}
