import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { CloudService } from './service.ts';
import { CloudError } from './identity.ts';
import { IdSchema, SequenceSchema, PushHintSchema } from '../../shared/cloud-protocol/index.ts';
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
/** Builds and persists redacted hints only. No network/provider sender exists. */
export class PushHints {
    s: CloudService;
    constructor(s: CloudService) { this.s = s; }
    async renew(token: string, w: string, body: unknown) {
        const b = z.object({ installation_id: IdSchema, generation: SequenceSchema, token_version: SequenceSchema, provider: z.literal('apns'), environment: z.literal('sandbox'), muted: z.boolean(), mentions_only: z.boolean().optional().default(false) }).strict().parse(body);
        return this.s.protect(token, w, undefined, 'push.renew', {}, async (q, i, a) => {
            const old = (await q.query('SELECT * FROM cloud.push_registrations WHERE workspace_id=$1 AND account_id=$2 AND installation_id=$3 ORDER BY generation DESC,token_version DESC LIMIT 1 FOR UPDATE', [w, i.account_id, b.installation_id])).rows[0];
            if (old && (BigInt(b.generation) < BigInt(old.generation) || (b.generation === String(old.generation) && BigInt(b.token_version) < BigInt(old.token_version))))
                throw new CloudError('control_conflict', 409);
            await q.query('UPDATE cloud.push_registrations SET revoked=true WHERE workspace_id=$1 AND account_id=$2 AND installation_id=$3', [w, i.account_id, b.installation_id]);
            const registration_id = randomBytes(18).toString('base64url'), expires_at = new Date(a.member.role === 'guest' ? i.expires_at : Date.now() + 7 * 86400000).toISOString();
            await q.query('INSERT INTO cloud.push_registrations(workspace_id,registration_id,account_id,session_hash,installation_id,generation,token_version,provider,environment,expires_at,muted,mentions_only) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)', [w, registration_id, i.account_id, hash(token), b.installation_id, b.generation, b.token_version, b.provider, b.environment, expires_at, b.muted, b.mentions_only]);
            return { registration_id, expires_at };
        });
    }
    async revoke(token: string, w: string, reg: string) { return this.s.protect(token, w, undefined, 'push.revoke', {}, async (q, i) => { await q.query('UPDATE cloud.push_registrations SET revoked=true WHERE workspace_id=$1 AND account_id=$2 AND registration_id=$3', [w, i.account_id, IdSchema.parse(reg)]); return { revoked: true }; }); }
    async build(token: string, w: string, r: string, reg: string, event: string) {
        return this.s.protect(token, w, r, 'push.build', {}, async (q, i) => {
            const v = (await q.query('SELECT * FROM cloud.push_registrations WHERE workspace_id=$1 AND registration_id=$2', [w, IdSchema.parse(reg)])).rows[0];
            if (!v || v.account_id !== i.account_id || v.session_hash !== hash(token) || v.revoked || v.muted || v.expires_at.getTime() <= Date.now())
                throw new CloudError('forbidden');
            const e = (await q.query("SELECT * FROM cloud.room_events WHERE workspace_id=$1 AND room_id=$2 AND event_id=$3 AND kind IN ('message.created','final.commit')", [w, r, IdSchema.parse(event)])).rows[0];
            if (!e || e.payload?.message?.actor_id === i.account_id || (v.mentions_only && !e.payload?.message?.mentions?.some((m: any) => m.kind === 'human' && m.id === i.account_id)))
                throw new CloudError('forbidden');
            const old = (await q.query('SELECT payload FROM cloud.push_hints WHERE workspace_id=$1 AND account_id=$2 AND installation_id=$3 AND event_id=$4', [w, i.account_id, v.installation_id, event])).rows[0];
            if (old)
                return { payload: old.payload, duplicate: true };
            const payload = PushHintSchema.parse({ kind: 'room_sync', workspace_id: w, room_id: r, event_id: event, preview: 'New activity' });
            await q.query('INSERT INTO cloud.push_hints VALUES($1,$2,$3,$4,$5,$6,$7)', [w, reg, r, event, payload, i.account_id, v.installation_id]);
            return { payload, duplicate: false };
        });
    }
}
