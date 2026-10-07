import { z } from 'zod';

export const SCHEMA_VERSION = 1 as const;
export const LIMITS = Object.freeze({ textBytes: 65536, replayEvents: 100, replayBytes: 1048576, socketBytes: 1048576, socketFrames: 1000, snapshotMessages: 50, historyMessages: 100, sparseIntervals: 256, subscriptions: 50, requestMs: 10000, snapshotMs: 300000, assertionMs: 15000, windowMs: 2592000000 });
export const ERROR_CODES = ['invalid_request','identity_unavailable','unauthenticated','forbidden','not_found','operation_conflict','operation_expired','policy_changed','invalid_mention','unsupported_attachment','invalid_reply','recovery_unknown','cursor_invalid','snapshot_expired','visibility_changed','upgrade_required','read_coverage_limit','rate_limited','invite_expired','invite_revoked','invite_used','last_owner','unavailable','deadline_exceeded'] as const;
export const ErrorCodeSchema = z.enum(ERROR_CODES);
export const IdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
export const SequenceSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);
export const RoleSchema = z.enum(['owner','admin','member','guest']);
export const NamespaceSchema = z.object({ service: z.string().min(1), issuer: z.string().min(1), subject: z.string().min(1), account_id: IdSchema, workspace_id: IdSchema, epoch: IdSchema }).strict();
export const MentionSchema = z.object({ kind: z.enum(['human','bot']), id: IdSchema, start: z.number().int().nonnegative(), end: z.number().int().positive() }).strict();
export function validMentions(text: string, mentions: z.infer<typeof MentionSchema>[]): boolean {
  const boundary = (n: number) => !(n > 0 && n < text.length && /[\uD800-\uDBFF]/.test(text[n-1]) && /[\uDC00-\uDFFF]/.test(text[n]));
  let end = 0;
  for (const m of [...mentions].sort((a,b) => a.start-b.start)) {
    if (m.start < end || m.end <= m.start || m.end > text.length || !boundary(m.start) || !boundary(m.end)) return false;
    end = m.end;
  }
  return true;
}
export const SendEnvelopeSchema = z.object({
  kind: z.literal('message.send'), namespace: NamespaceSchema,
  client_operation_id: z.string().regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{16,128}$/),
  window_token: z.string().min(1).max(4096), room_id: IdSchema, thread_id: IdSchema,
  text: z.string().refine(s => new TextEncoder().encode(s).length <= LIMITS.textBytes, 'text exceeds 64 KiB'),
  mentions: z.array(MentionSchema).max(256), attachment_ids: z.array(IdSchema).max(32),
  reply_to_message_id: IdSchema.nullable(), expected_policy_revision: SequenceSchema,
}).strict().refine(e => validMentions(e.text, e.mentions), 'invalid UTF-16 mention spans');
export const ErrorSchema = z.object({ error: ErrorCodeSchema, retry_after: z.number().nonnegative().optional() }).strict();
export const MessageSchema = z.object({ workspace_id: IdSchema, room_id: IdSchema, thread_id: IdSchema, message_id: IdSchema, actor_id: IdSchema, client_operation_id: z.string(), sequence: SequenceSchema, version: z.number().int().positive(), text: z.string(), mentions: z.array(MentionSchema), reply_to_message_id: IdSchema.nullable(), deleted: z.boolean(), created_at: z.string() }).strict();
export const AcceptanceSchema = z.object({ status: z.literal('accepted'), client_operation_id: z.string(), digest: z.string().regex(/^[a-f0-9]{64}$/), message_id: IdSchema, room_id: IdSchema, thread_id: IdSchema, sequence: SequenceSchema, redacted: z.boolean(), retry: z.literal('none') }).strict();
export const RejectionSchema = z.object({ status: z.literal('rejected'), client_operation_id: z.string(), digest: z.string().regex(/^[a-f0-9]{64}$/), reason: ErrorCodeSchema, retry: z.literal('none') }).strict();
export const LookupSchema = z.discriminatedUnion('status', [AcceptanceSchema, RejectionSchema, z.object({ status: z.literal('not_found'), client_operation_id: z.string(), retry: z.literal('unchanged_or_seal') }).strict(), z.object({ status: z.literal('recovery_unknown'), client_operation_id: z.string(), retry: z.literal('reconcile_only') }).strict()]);
export const EVENT_KINDS = ['message.created','message.updated','message.deleted','room.policy_changed','room.membership_changed','presence'] as const;
export const EventSchema = z.object({ schema_version: z.number().int().positive(), workspace_id: IdSchema, room_id: IdSchema, event_id: IdSchema, sequence: SequenceSchema, kind: z.string(), required: z.boolean(), payload: z.record(z.string(), z.unknown()) }).strict();
export const IntervalSchema = z.tuple([SequenceSchema, SequenceSchema]).refine(([a,b]) => BigInt(a) <= BigInt(b));
export const ReadCoverageSchema = z.object({ prefix: SequenceSchema, intervals: z.array(IntervalSchema).max(LIMITS.sparseIntervals), attention: z.boolean() }).strict();
export const MemberSchema = z.object({ account_id: IdSchema, role: RoleSchema }).strict();
export const SnapshotSchema = z.object({ snapshot_id: IdSchema, expires_at: z.string(), workspace_id: IdSchema, room_id: IdSchema, thread_id: IdSchema, watermark: SequenceSchema, frontier: SequenceSchema, cursor: z.string(), policy_revision: SequenceSchema, messages: z.array(MessageSchema).max(50), members: z.array(MemberSchema), threads: z.array(z.object({ thread_id: IdSchema, archived: z.boolean() }).strict()), capabilities: z.array(z.string()), read: ReadCoverageSchema, active_runs: z.array(z.unknown()), cards: z.array(z.unknown()) }).strict();
export const SubscribeSchema = z.object({ type: z.literal('subscribe'), workspace_id: IdSchema, room_id: IdSchema, thread_id: IdSchema, cursor: z.string().nullable(), snapshot_id: IdSchema.optional() }).strict();
export const BatchSchema = z.object({ type: z.literal('event_batch'), workspace_id: IdSchema, room_id: IdSchema, events: z.array(EventSchema).max(100), cursor: z.string(), scanned_sequence: SequenceSchema, frontier: SequenceSchema, live: z.boolean() }).strict();
export const ResetSchema = z.object({ type: z.literal('reset_required'), workspace_id: IdSchema, room_id: IdSchema, reason: z.enum(['cursor_invalid','visibility_changed','overflow','snapshot_expired']), snapshot: SnapshotSchema.optional() }).strict();
export const FrameSchema = z.discriminatedUnion('type',[BatchSchema, ResetSchema, z.object({ type: z.literal('error'), error: ErrorCodeSchema }).strict(), z.object({type:z.literal('heartbeat')}).strict()]);
export type SendEnvelope = z.infer<typeof SendEnvelopeSchema>;
export type CloudMessage = z.infer<typeof MessageSchema>;
export type CloudEvent = z.infer<typeof EventSchema>;
export type OperationResult = z.infer<typeof LookupSchema>;
export type CloudSnapshot = z.infer<typeof SnapshotSchema>;
export type CloudFrame = z.infer<typeof FrameSchema>;
export type ReadCoverage = z.infer<typeof ReadCoverageSchema>;
/** Digest input: compact JSON, object keys recursively sorted by UTF-16 code unit;
 * array order and exact strings preserved; SHA-256 over UTF-8 bytes. No normalization. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '['+value.map(canonicalJson).join(',')+']';
  if (value !== null && typeof value === 'object') return '{'+Object.keys(value).sort().map(k => JSON.stringify(k)+':'+canonicalJson((value as Record<string,unknown>)[k])).join(',')+'}';
  const json = JSON.stringify(value);
  if (json === undefined) throw new TypeError('non-JSON value');
  return json;
}
