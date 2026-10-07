import { randomBytes, createHash } from 'node:crypto';
import type { CloudService } from './service.ts';
import type { Sql } from './db.ts';
import { CloudError } from './identity.ts';
import { BotRegistrationSchema, HostRegistrationSchema, HostClaimSchema, RunBindingSchema, HostAppendSchema, RunControlSchema, ApprovalCreateSchema, ApprovalDecisionSchema, InvocationSchema, ApprovalCardSchema, canonicalJson } from '../../shared/cloud-protocol/index.ts';
const id = () => randomBytes(18).toString('base64url');
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
const active = ['queued', 'leased', 'running', 'waiting_for_human'];
export class RoomRuntime {
    s: CloudService;
    constructor(s: CloudService) { this.s = s; }
    binding(v: any) { return { invocation_id: v.invocation_id, attempt: v.attempt, fence_gen: String(v.fence_gen) }; }
    run(v: any) { return InvocationSchema.parse({ workspace_id: v.workspace_id, room_id: v.room_id, thread_id: v.thread_id, bot_id: v.bot_id, ...this.binding(v), state: v.state, model: v.model, source: v.source, control_revision: String(v.control_revision), host_id: v.host_id, lease_expires_at: v.lease_expires_at?.toISOString() ?? null, queued_expires_at: v.queued_expires_at.toISOString(), result_message_id: v.result_message_id, stop_requested: v.stop_requested, stopped_observed: v.stopped_observed, replay_safe: v.replay_safe, host_online: v.host_online }); }
    async row(q: Sql, w: string, inv: string) { const v = (await q.query('SELECT * FROM cloud.invocations WHERE workspace_id=$1 AND invocation_id=$2 FOR UPDATE', [w, inv])).rows[0]; if (!v)
        throw new CloudError('not_found', 404); return v; }
    async granted(q: Sql, w: string, r: string, account: string) { return !!(await q.query("SELECT 1 FROM cloud.members m WHERE workspace_id=$1 AND account_id=$2 AND (role<>'guest' OR EXISTS(SELECT 1 FROM cloud.room_grants WHERE workspace_id=$1 AND room_id=$3 AND account_id=$2))", [w, account, r])).rowCount; }
    async validBot(q: Sql, w: string, r: string, bot: string) { const b = (await q.query('SELECT b.* FROM cloud.bots b JOIN cloud.bot_rooms g USING(workspace_id,bot_id) WHERE b.workspace_id=$1 AND g.room_id=$2 AND b.bot_id=$3', [w, r, bot])).rows[0]; return b && await this.granted(q, w, r, b.owner_id) ? b : undefined; }
    async validate(q: Sql, w: string, r: string, t: string, actor: string, mentions: any[], attachments: string[]) {
        for (const m of mentions)
            if (m.kind === 'bot' && !await this.validBot(q, w, r, m.id))
                return 'invalid_mention';
        for (const a of attachments) {
            const v = (await q.query("SELECT 1 FROM cloud.attachment_objects WHERE workspace_id=$1 AND room_id=$2 AND thread_id=$3 AND attachment_id=$4 AND owner_id=$5 AND state='ready' AND (attached OR expires_at>clock_timestamp())", [w, r, t, a, actor])).rowCount;
            if (!v)
                return 'attachment_unready';
        }
    }
    async offer(q: Sql, w: string, r: string, t: string, message: any, attachments: string[]) {
        for (const bot of new Set<string>(message.mentions.filter((m: any) => m.kind === 'bot').map((m: any) => m.id))) {
            const b = await this.validBot(q, w, r, bot);
            if (!b)
                throw new CloudError('invalid_mention');
            const source = { message_id: message.message_id, version: message.version, actor_id: message.actor_id, text: message.text, mentions: message.mentions, attachment_ids: attachments };
            const pinned = { ...source, digest: hash(canonicalJson(source)) };
            const v = (await q.query("INSERT INTO cloud.invocations(workspace_id,room_id,thread_id,invocation_id,bot_id,source_message_id,source_actor_id,source,model,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'queued') RETURNING *", [w, r, t, id(), bot, message.message_id, message.actor_id, JSON.stringify(pinned), b.model])).rows[0];
            v.host_online = (await q.query("SELECT EXISTS(SELECT 1 FROM cloud.hosts WHERE workspace_id=$1 AND bot_ids ? $2 AND NOT revoked AND expires_at>clock_timestamp() AND last_seen>clock_timestamp()-interval '30 seconds') AS online", [w, bot])).rows[0].online;
            await this.s.event(q, w, r, t, 'invocation.offered', { kind: 'invocation.offered', ...this.binding(v), invocation: this.run(v) });
        }
    }
    async registerBot(token: string, w: string, body: unknown) {
        const b = BotRegistrationSchema.parse(body);
        return this.s.protect(token, w, undefined, 'bot.register', {}, async (q, i, a) => {
            this.s.admin(a);
            for (const r of b.room_ids)
                if (!(await q.query('SELECT 1 FROM cloud.rooms WHERE workspace_id=$1 AND room_id=$2', [w, r])).rowCount)
                    throw new CloudError('forbidden');
            // Redefinition never changes an accepted invocation/model.
            await q.query('INSERT INTO cloud.bots VALUES($1,$2,$3,$4,$5) ON CONFLICT(workspace_id,bot_id) DO UPDATE SET name=EXCLUDED.name,model=EXCLUDED.model', [w, b.bot_id, i.account_id, b.name, b.model]);
            await q.query('DELETE FROM cloud.bot_rooms WHERE workspace_id=$1 AND bot_id=$2', [w, b.bot_id]);
            for (const r of b.room_ids)
                await q.query('INSERT INTO cloud.bot_rooms VALUES($1,$2,$3)', [w, b.bot_id, r]);
            for (const v of (await q.query("SELECT * FROM cloud.invocations WHERE workspace_id=$1 AND bot_id=$2 AND state IN ('queued','leased','running','waiting_for_human') AND NOT(room_id=ANY($3::text[]))", [w, b.bot_id, b.room_ids])).rows)
                await this.hold(q, v);
            await this.s.bumpPolicies(q, w);
            return { bot_id: b.bot_id };
        });
    }
    async registerHost(token: string, w: string, body: unknown) {
        const b = HostRegistrationSchema.parse(body);
        return this.s.protect(token, w, undefined, 'host.register', {}, async (q, i, a) => {
            this.s.admin(a);
            for (const bot of b.bot_ids)
                if (!(await q.query('SELECT 1 FROM cloud.bots WHERE workspace_id=$1 AND bot_id=$2 AND owner_id=$3', [w, bot, i.account_id])).rowCount)
                    throw new CloudError('forbidden');
            const h = id(), expires_at = new Date(Date.now() + 7 * 86400000).toISOString(), credential = 'h_' + randomBytes(48).toString('base64url');
            await q.query('INSERT INTO cloud.hosts(workspace_id,host_id,owner_id,name,bot_ids,credential_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)', [w, h, i.account_id, b.name, JSON.stringify(b.bot_ids), hash(credential), expires_at]);
            await this.presence(q, w, { host_id: h, bot_ids: b.bot_ids }, true);
            return { host_id: h, host_credential: credential, workspace_id: w, expires_at, lease_seconds: 30, heartbeat_seconds: 10 };
        });
    }
    async host(q: Sql, w: string, h: string, account: string, credential: string) {
        const v = (await q.query('SELECT * FROM cloud.hosts WHERE workspace_id=$1 AND host_id=$2 FOR UPDATE', [w, h])).rows[0];
        if (!v || v.revoked || v.owner_id !== account || v.expires_at.getTime() <= Date.now() || hash(credential) !== v.credential_hash)
            throw new CloudError('host_invalid', 401);
        await q.query('UPDATE cloud.hosts SET last_seen=clock_timestamp(),online=true WHERE workspace_id=$1 AND host_id=$2', [w, h]);
        if (!v.online)
            await this.presence(q, w, v, true);
        return v;
    }
    async authority(q: Sql, v: any) { return await this.granted(q, v.workspace_id, v.room_id, v.source_actor_id) && !!await this.validBot(q, v.workspace_id, v.room_id, v.bot_id); }
    async hold(q: Sql, v: any) {
        if (!active.includes(v.state) && v.state !== 'held')
            return v;
        v = (await q.query("UPDATE cloud.invocations SET state='held',fence_gen=fence_gen+1,control_revision=control_revision+1,lease_expires_at=NULL,replay_safe=false WHERE workspace_id=$1 AND invocation_id=$2 RETURNING *", [v.workspace_id, v.invocation_id])).rows[0];
        await this.revokeCards(q, v);
        await this.s.event(q, v.workspace_id, v.room_id, v.thread_id, 'run.updated', { invocation: this.run(v) });
        return v;
    }
    async revokeCards(q: Sql, v: any) {
        for (const card of (await q.query("UPDATE cloud.approvals SET status='revoked',version=version+1 WHERE workspace_id=$1 AND invocation_id=$2 AND status='pending' RETURNING *", [v.workspace_id, v.invocation_id])).rows)
            await this.s.event(q, v.workspace_id, v.room_id, v.thread_id, 'approval.updated', { actor_id: card.actor_id, card: this.card(card, card.actor_id) });
    }
    async revokeActor(q: Sql, w: string, account: string) {
        await q.query('UPDATE cloud.hosts SET revoked=true WHERE workspace_id=$1 AND owner_id=$2', [w, account]);
        const runs = (await q.query("SELECT v.* FROM cloud.invocations v LEFT JOIN cloud.bots b USING(workspace_id,bot_id) LEFT JOIN cloud.hosts h USING(workspace_id,host_id) WHERE v.workspace_id=$1 AND (v.source_actor_id=$2 OR b.owner_id=$2 OR h.owner_id=$2 OR EXISTS(SELECT 1 FROM cloud.approvals a WHERE a.workspace_id=v.workspace_id AND a.invocation_id=v.invocation_id AND a.actor_id=$2 AND a.status IN ('pending','approved'))) AND v.state IN ('queued','leased','running','waiting_for_human','held') FOR UPDATE OF v", [w, account])).rows;
        for (const v of runs)
            await this.hold(q, v);
        await q.query("UPDATE cloud.approvals SET status='revoked',version=version+1 WHERE workspace_id=$1 AND actor_id=$2 AND status='pending'", [w, account]);
        await q.query('UPDATE cloud.push_registrations SET revoked=true WHERE workspace_id=$1 AND account_id=$2', [w, account]);
    }
    async revokeHost(token: string, w: string, h: string) { return this.s.protect(token, w, undefined, 'host.revoke', {}, async (q, _i, a) => { this.s.admin(a); await q.query('UPDATE cloud.hosts SET revoked=true WHERE workspace_id=$1 AND host_id=$2', [w, h]); for (const v of (await q.query("SELECT * FROM cloud.invocations WHERE workspace_id=$1 AND host_id=$2 AND state IN ('leased','running','waiting_for_human')", [w, h])).rows)
        await this.hold(q, v); return { revoked: true }; }); }
    async presence(q: Sql, w: string, h: any, online: boolean) {
        for (const room of (await q.query('SELECT DISTINCT room_id FROM cloud.bot_rooms WHERE workspace_id=$1 AND bot_id=ANY(SELECT jsonb_array_elements_text($2::jsonb))', [w, JSON.stringify(h.bot_ids)])).rows)
            await this.s.event(q, w, room.room_id, null, 'presence', { host_id: h.host_id, online });
    }
    async sweep(q: Sql, w: string) {
        for (const h of (await q.query("UPDATE cloud.hosts SET online=false WHERE workspace_id=$1 AND online AND (last_seen<=clock_timestamp()-interval '30 seconds' OR revoked OR expires_at<=clock_timestamp()) RETURNING *", [w])).rows)
            await this.presence(q, w, h, false);
        for (const card of (await q.query("UPDATE cloud.approvals SET status='expired',version=version+1 WHERE workspace_id=$1 AND status='pending' AND expires_at<=clock_timestamp() RETURNING *", [w])).rows) {
            const v = await this.row(q, w, card.invocation_id);
            await this.hold(q, v);
            await this.s.event(q, w, card.room_id, card.thread_id, 'approval.updated', { actor_id: card.actor_id, card: this.card(card, card.actor_id) });
        }
        for (const v of (await q.query("SELECT * FROM cloud.invocations WHERE workspace_id=$1 AND state IN ('queued','leased','running','waiting_for_human')", [w])).rows) {
            if (v.state === 'queued' && v.queued_expires_at.getTime() <= Date.now()) {
                const next = (await q.query("UPDATE cloud.invocations SET state='failed',fence_gen=fence_gen+1 WHERE workspace_id=$1 AND invocation_id=$2 RETURNING *", [w, v.invocation_id])).rows[0];
                await this.s.event(q, w, v.room_id, v.thread_id, 'run.updated', { invocation: this.run(next) });
            }
            else if (!await this.authority(q, v) || (['leased', 'running'].includes(v.state) && v.lease_expires_at.getTime() <= Date.now() && !v.replay_safe))
                await this.hold(q, v);
        }
    }
    async offers(token: string, w: string, h: string, credential: string) {
        return this.s.protect(token, w, undefined, 'host.offers', {}, async (q, i) => {
            const host = await this.host(q, w, h, i.account_id, credential);
            await this.sweep(q, w);
            const list = (await q.query("SELECT * FROM cloud.invocations WHERE workspace_id=$1 AND bot_id=ANY(SELECT jsonb_array_elements_text($2::jsonb)) AND (state='queued' OR (state IN ('leased','running') AND lease_expires_at<=clock_timestamp() AND replay_safe)) ORDER BY queued_expires_at LIMIT 100", [w, JSON.stringify(host.bot_ids)])).rows;
            const invocations = [];
            for (const v of list)
                if (await this.granted(q, w, v.room_id, i.account_id) && await this.authority(q, v))
                    invocations.push(this.run(v));
            return { invocations };
        });
    }
    async claim(token: string, w: string, h: string, credential: string, body: unknown) {
        const b = HostClaimSchema.parse(body);
        return this.s.protect(token, w, undefined, 'host.claim', { invocation_id: b.invocation_id }, async (q, i) => {
            const host = await this.host(q, w, h, i.account_id, credential);
            await this.sweep(q, w);
            let v = await this.row(q, w, b.invocation_id);
            if (!host.bot_ids.includes(v.bot_id) || !await this.granted(q, w, v.room_id, i.account_id) || !await this.authority(q, v))
                throw new CloudError('forbidden');
            if (v.host_id === h && ['leased', 'running'].includes(v.state) && v.lease_expires_at.getTime() > Date.now())
                return this.run(v);
            if (v.stop_requested || !(v.state === 'queued' || (['leased', 'running'].includes(v.state) && v.lease_expires_at.getTime() <= Date.now() && v.replay_safe)))
                throw new CloudError('lease_lost', 409);
            v = (await q.query("UPDATE cloud.invocations SET state='leased',host_id=$3,attempt=attempt+1,fence_gen=fence_gen+1,lease_expires_at=clock_timestamp()+interval '30 seconds',replay_safe=true WHERE workspace_id=$1 AND invocation_id=$2 RETURNING *", [w, b.invocation_id, h])).rows[0];
            await q.query('INSERT INTO cloud.run_attempts(workspace_id,invocation_id,attempt,fence_gen,host_id,model) VALUES($1,$2,$3,$4,$5,$6)', [w, v.invocation_id, v.attempt, v.fence_gen, h, v.model]);
            await this.s.event(q, w, v.room_id, v.thread_id, 'invocation.claimed', { kind: 'invocation.claimed', ...this.binding(v), host_id: h, model: v.model, lease_expires_at: v.lease_expires_at.toISOString() });
            return this.run(v);
        });
    }
    assertBinding(v: any, b: any, h?: string, allowStopped = false) {
        if (v.attempt !== b.attempt || String(v.fence_gen) !== b.fence_gen || (h && v.host_id !== h) || (!allowStopped && (!['leased', 'running'].includes(v.state) || v.stop_requested || !v.lease_expires_at || v.lease_expires_at.getTime() <= Date.now())))
            throw new CloudError('lease_lost', 409);
    }
    async heartbeat(token: string, w: string, h: string, credential: string, body: unknown) {
        const b = RunBindingSchema.parse(body);
        return this.s.protect(token, w, undefined, 'host.heartbeat', {}, async (q, i) => {
            await this.host(q, w, h, i.account_id, credential);
            let v = await this.row(q, w, b.invocation_id);
            this.assertBinding(v, b, h);
            if (!await this.authority(q, v) || !await this.granted(q, w, v.room_id, i.account_id))
                throw new CloudError('forbidden');
            v = (await q.query("UPDATE cloud.invocations SET lease_expires_at=clock_timestamp()+interval '30 seconds' WHERE workspace_id=$1 AND invocation_id=$2 RETURNING *", [w, v.invocation_id])).rows[0];
            return this.run(v);
        });
    }
    async append(token: string, w: string, h: string, credential: string, body: unknown) {
        const b = HostAppendSchema.parse(body);
        return this.s.protect(token, w, undefined, 'host.event', { invocation_id: b.invocation_id }, async (q, i) => {
            await this.host(q, w, h, i.account_id, credential);
            let v = await this.row(q, w, b.invocation_id);
            if (!await this.granted(q, w, v.room_id, i.account_id) || !await this.authority(q, v))
                throw new CloudError('forbidden');
            // A final response retry has no publication and no second result, even after lease expires.
            if (b.kind === 'final.commit' && v.state === 'completed' && v.host_id === h && v.attempt === b.attempt && String(v.fence_gen) === b.fence_gen) {
                const old = (await q.query("SELECT digest FROM cloud.run_events WHERE workspace_id=$1 AND invocation_id=$2 AND attempt=$3 AND event_key='final.commit'", [w, v.invocation_id, v.attempt])).rows[0];
                if (old?.digest !== hash(canonicalJson(b)))
                    throw new CloudError('operation_conflict', 409);
                return this.run(v);
            }
            if (b.kind === 'approval.create' && v.host_id === h && v.attempt === b.attempt && String(v.fence_gen) === b.fence_gen && v.state === 'waiting_for_human') {
                const input = ApprovalCreateSchema.parse(b.approval);
                const old = (await q.query('SELECT * FROM cloud.approvals WHERE workspace_id=$1 AND invocation_id=$2 AND effect_id=$3', [w, v.invocation_id, input.effect_id])).rows[0];
                if (!old || old.actor_id !== input.actor_id || old.digest !== input.digest || old.title !== input.title)
                    throw new CloudError('operation_conflict', 409);
                return this.card(old, old.actor_id);
            }
            if (b.kind === 'stop.observed' && v.state === 'cancelled' && v.stopped_observed && v.host_id === h && v.attempt === b.attempt && String(v.fence_gen) === b.fence_gen && b.control_revision === String(v.control_revision))
                return this.run(v);
            this.assertBinding(v, b, h, b.kind === 'stop.observed');
            if (!await this.authority(q, v))
                throw new CloudError('forbidden');
            if (b.kind === 'stop.observed') {
                if (!v.stop_requested || b.control_revision !== String(v.control_revision) || v.state !== 'held')
                    throw new CloudError('control_conflict', 409);
                v = (await q.query("UPDATE cloud.invocations SET state='cancelled',stopped_observed=true WHERE workspace_id=$1 AND invocation_id=$2 RETURNING *", [w, v.invocation_id])).rows[0];
                await this.s.event(q, w, v.room_id, v.thread_id, 'stop.observed', { kind: 'stop.observed', ...this.binding(v), control_revision: String(v.control_revision) });
                return this.run(v);
            }
            if (b.kind === 'approval.create')
                return this.createApproval(q, v, b.approval);
            if (b.kind === 'checkpoint') {
                if (b.replay_safe !== false)
                    throw new CloudError('invalid_request', 400);
                // Only pre-provider leased work is automatically replay safe. No host assertion
                // can erase uncertainty after provider entry or reset a final result.
                v = (await q.query("UPDATE cloud.invocations SET state='running',replay_safe=false WHERE workspace_id=$1 AND invocation_id=$2 RETURNING *", [w, v.invocation_id])).rows[0];
                await this.s.event(q, w, v.room_id, v.thread_id, 'run.updated', { invocation: this.run(v) });
                return this.run(v);
            }
            if (b.text === undefined || (b.kind === 'stream.delta' && !b.delta_id))
                throw new CloudError('invalid_request', 400);
            const event_key = b.kind === 'stream.delta' ? 'delta.' + b.delta_id : 'final.commit', digest = hash(canonicalJson(b));
            const old = (await q.query('SELECT digest FROM cloud.run_events WHERE workspace_id=$1 AND invocation_id=$2 AND attempt=$3 AND event_key=$4', [w, v.invocation_id, v.attempt, event_key])).rows[0];
            if (old) {
                if (old.digest !== digest)
                    throw new CloudError('operation_conflict', 409);
                return this.run(v);
            }
            await q.query('INSERT INTO cloud.run_events VALUES($1,$2,$3,$4,$5,$6)', [w, v.invocation_id, v.attempt, v.fence_gen, event_key, digest]);
            if (b.kind === 'stream.delta') {
                if (Number(v.streamed_bytes) + Buffer.byteLength(b.text) > 1048576 || v.delta_count >= 1000)
                    throw new CloudError('rate_limited', 429);
                v = (await q.query("UPDATE cloud.invocations SET state='running',replay_safe=false,streamed_bytes=streamed_bytes+$3,delta_count=delta_count+1 WHERE workspace_id=$1 AND invocation_id=$2 RETURNING *", [w, v.invocation_id, Buffer.byteLength(b.text)])).rows[0];
                await this.s.event(q, w, v.room_id, v.thread_id, 'stream.delta', { kind: 'stream.delta', ...this.binding(v), delta_id: b.delta_id, text: b.text });
            }
            else {
                const msg = id(), seq = (await q.query('SELECT (head+1)::text AS n FROM cloud.rooms WHERE workspace_id=$1 AND room_id=$2', [w, v.room_id])).rows[0].n;
                const m = (await q.query('INSERT INTO cloud.messages(workspace_id,room_id,thread_id,message_id,actor_id,bot_id,client_operation_id,sequence,text,mentions,reply_to_message_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *', [w, v.room_id, v.thread_id, msg, i.account_id, v.bot_id, 'invocation.' + v.invocation_id, seq, JSON.stringify(b.text), '[]', v.source_message_id])).rows[0];
                await this.s.event(q, w, v.room_id, v.thread_id, 'final.commit', { kind: 'final.commit', ...this.binding(v), message: this.s.message(m) });
                v = (await q.query("UPDATE cloud.invocations SET state='completed',result_message_id=$3,lease_expires_at=NULL,replay_safe=false WHERE workspace_id=$1 AND invocation_id=$2 RETURNING *", [w, v.invocation_id, msg])).rows[0];
            }
            return this.run(v);
        });
    }
    async context(token: string, w: string, h: string, credential: string, body: unknown) {
        const b = RunBindingSchema.parse(body);
        return this.s.protect(token, w, undefined, 'host.context', {}, async (q, i) => {
            await this.host(q, w, h, i.account_id, credential);
            const v = await this.row(q, w, b.invocation_id);
            this.assertBinding(v, b, h);
            if (!await this.authority(q, v) || !await this.granted(q, w, v.room_id, i.account_id))
                throw new CloudError('forbidden');
            const rows = (await q.query('SELECT * FROM cloud.messages WHERE workspace_id=$1 AND room_id=$2 AND thread_id=$3 AND NOT deleted ORDER BY sequence DESC LIMIT 50', [w, v.room_id, v.thread_id])).rows.reverse();
            const messages = [];
            let text_bytes = Buffer.byteLength(v.source.text);
            for (const m of rows) {
                const n = Buffer.byteLength(m.text);
                if (text_bytes + n > 65536)
                    break;
                text_bytes += n;
                messages.push({ message: this.s.message(m), provenance: 'room_history', trust: 'untrusted' });
            }
            return { invocation_id: v.invocation_id, source: v.source, messages, text_bytes };
        });
    }
    async control(token: string, w: string, r: string, inv: string, body: unknown, resume = false) {
        const b = RunControlSchema.parse(body);
        if (b.invocation_id !== inv)
            throw new CloudError('invalid_request', 400);
        return this.s.protect(token, w, r, resume ? 'run.resume' : 'run.stop', {}, async (q, i, a) => {
            let v = await this.row(q, w, inv);
            if (v.room_id !== r || (!(a.member.role === 'owner' || a.member.role === 'admin') && v.source_actor_id !== i.account_id))
                throw new CloudError('forbidden');
            if (!resume && v.stop_requested && v.attempt === b.attempt && String(v.fence_gen) === b.fence_gen && BigInt(v.control_revision) === BigInt(b.control_revision) + 1n)
                return this.run(v);
            if (v.attempt !== b.attempt || String(v.fence_gen) !== b.fence_gen || String(v.control_revision) !== b.control_revision)
                throw new CloudError('control_conflict', 409);
            if (['completed', 'failed', 'cancelled'].includes(v.state) && !resume)
                return this.run(v);
            if (resume) {
                // Explicit resume only after verified host termination; never blindly replay uncertainty.
                if (!['held', 'cancelled'].includes(v.state) || !v.stopped_observed || !await this.authority(q, v))
                    throw new CloudError('control_conflict', 409);
                v = (await q.query("UPDATE cloud.invocations SET state='queued',stop_requested=false,stopped_observed=false,host_id=NULL,fence_gen=fence_gen+1,control_revision=control_revision+1,replay_safe=true,queued_expires_at=clock_timestamp()+interval '24 hours' WHERE workspace_id=$1 AND invocation_id=$2 RETURNING *", [w, inv])).rows[0];
            }
            else {
                if (v.stop_requested)
                    return this.run(v);
                v = (await q.query("UPDATE cloud.invocations SET state='held',stop_requested=true,control_revision=control_revision+1,lease_expires_at=NULL,replay_safe=false WHERE workspace_id=$1 AND invocation_id=$2 RETURNING *", [w, inv])).rows[0];
                await this.revokeCards(q, v);
                await this.s.event(q, w, r, v.thread_id, 'stop.requested', { kind: 'stop.requested', ...this.binding(v), control_revision: String(v.control_revision) });
            }
            await this.s.event(q, w, r, v.thread_id, 'run.updated', { invocation: this.run(v) });
            return this.run(v);
        });
    }
    card(v: any, account: string) { return ApprovalCardSchema.parse({ ...this.binding(v), approval_id: v.approval_id, workspace_id: v.workspace_id, room_id: v.room_id, thread_id: v.thread_id, actor_id: v.actor_id, version: v.version, effect_id: v.effect_id, digest: v.digest, title: v.title, expires_at: v.expires_at.toISOString(), status: v.status, can_view: true, can_decide: v.actor_id === account && v.status === 'pending' && v.expires_at.getTime() > Date.now() }); }
    async createApproval(q: Sql, v: any, body: unknown) {
        const b = ApprovalCreateSchema.parse(body);
        if (!await this.granted(q, v.workspace_id, v.room_id, b.actor_id))
            throw new CloudError('forbidden');
        const card = (await q.query("INSERT INTO cloud.approvals(workspace_id,room_id,thread_id,invocation_id,approval_id,actor_id,attempt,fence_gen,effect_id,digest,title,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,clock_timestamp()+$12*interval '1 second') RETURNING *", [v.workspace_id, v.room_id, v.thread_id, v.invocation_id, id(), b.actor_id, v.attempt, v.fence_gen, b.effect_id, b.digest, b.title, b.expires_in_seconds])).rows[0];
        v = (await q.query("UPDATE cloud.invocations SET state='waiting_for_human',lease_expires_at=NULL,replay_safe=false WHERE workspace_id=$1 AND invocation_id=$2 RETURNING *", [v.workspace_id, v.invocation_id])).rows[0];
        await this.s.event(q, v.workspace_id, v.room_id, v.thread_id, 'approval.updated', { actor_id: card.actor_id, card: this.card(card, card.actor_id) });
        await this.s.event(q, v.workspace_id, v.room_id, v.thread_id, 'run.updated', { invocation: this.run(v) });
        return this.card(card, card.actor_id);
    }
    async approval(token: string, w: string, r: string, approval: string, body?: unknown) {
        const b = body === undefined ? undefined : ApprovalDecisionSchema.parse(body);
        return this.s.protect(token, w, r, b ? 'approval.decision' : 'approval.view', {}, async (q, i) => {
            let card = (await q.query('SELECT * FROM cloud.approvals WHERE workspace_id=$1 AND room_id=$2 AND approval_id=$3 FOR UPDATE', [w, r, approval])).rows[0];
            if (!card || card.actor_id !== i.account_id)
                throw new CloudError('forbidden');
            let v = await this.row(q, w, card.invocation_id);
            if (!await this.authority(q, v) || card.expires_at.getTime() <= Date.now() || v.state !== 'waiting_for_human') {
                let changed = false;
                if (card.status === 'pending') {
                    changed = true;
                    card = (await q.query("UPDATE cloud.approvals SET status=$3,version=version+1 WHERE workspace_id=$1 AND approval_id=$2 RETURNING *", [w, approval, card.expires_at.getTime() <= Date.now() ? 'expired' : 'revoked'])).rows[0];
                }
                if (v.state === 'waiting_for_human')
                    await this.hold(q, v);
                if (changed)
                    await this.s.event(q, w, r, card.thread_id, 'approval.updated', { actor_id: card.actor_id, card: this.card(card, i.account_id) });
                if (b)
                    return { error: card.status === 'expired' ? 'approval_expired' : 'approval_decided' };
                return this.card(card, i.account_id);
            }
            if (!b)
                return this.card(card, i.account_id);
            if (card.status !== 'pending')
                throw new CloudError('approval_decided', 409);
            if (b.version !== card.version || b.invocation_id !== card.invocation_id || b.attempt !== card.attempt || b.fence_gen !== String(card.fence_gen) || b.effect_id !== card.effect_id || b.digest !== card.digest || v.attempt !== card.attempt || String(v.fence_gen) !== String(card.fence_gen))
                throw new CloudError('control_conflict', 409);
            card = (await q.query("UPDATE cloud.approvals SET status=$3,version=version+1 WHERE workspace_id=$1 AND approval_id=$2 RETURNING *", [w, approval, b.decision === 'approve' ? 'approved' : 'denied'])).rows[0];
            // An approval is not an effect dispatch permit. Explicit host continuation is
            // fenced under the same attempt; denial keeps work held.
            v = (await q.query("UPDATE cloud.invocations SET state=$3,control_revision=control_revision+1,lease_expires_at=CASE WHEN $3='running' THEN clock_timestamp()+interval '30 seconds' ELSE NULL END WHERE workspace_id=$1 AND invocation_id=$2 RETURNING *", [w, v.invocation_id, b.decision === 'approve' ? 'running' : 'held'])).rows[0];
            await this.s.event(q, w, r, v.thread_id, 'approval.updated', { actor_id: card.actor_id, card: this.card(card, i.account_id) });
            await this.s.event(q, w, r, v.thread_id, 'run.updated', { invocation: this.run(v) });
            return this.card(card, i.account_id);
        });
    }
    async projection(q: Sql, w: string, r: string, t: string, actor: string) {
        await this.sweep(q, w);
        const runs = (await q.query("SELECT v.*,EXISTS(SELECT 1 FROM cloud.hosts h WHERE h.workspace_id=v.workspace_id AND NOT h.revoked AND h.expires_at>clock_timestamp() AND h.last_seen>clock_timestamp()-interval '30 seconds' AND h.bot_ids ? v.bot_id) AS host_online FROM cloud.invocations v WHERE workspace_id=$1 AND room_id=$2 AND thread_id=$3 AND state NOT IN ('completed','failed','cancelled') ORDER BY queued_expires_at LIMIT 100", [w, r, t])).rows;
        const cards = (await q.query('SELECT * FROM cloud.approvals WHERE workspace_id=$1 AND room_id=$2 AND thread_id=$3 AND actor_id=$4 ORDER BY expires_at LIMIT 100', [w, r, t, actor])).rows;
        return { active_runs: runs.map(v => this.run(v)), cards: cards.map(v => this.card(v, actor)) };
    }
}
