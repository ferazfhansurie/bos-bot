// Slice 3/4 wire shapes built against the names frozen in
// plans/bos-2.0-slices/slice-3-freeze.md and slice-4-freeze.md, until api's
// shared/cloud-protocol schema commit lands. On rebase this file becomes
// re-exports from shared/cloud-protocol; nothing else should define these.
import { z } from "zod";
// Self-contained (no import of shared/cloud-protocol) so both the server and the
// web tsconfigs accept it; the copies below match shared/cloud-protocol exactly.
const IdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const SequenceSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);
const MentionSchema = z.object({ kind: z.enum(["human", "bot"]), id: IdSchema, start: z.number().int().nonnegative(), end: z.number().int().positive() }).strict();

// ---- run states (frozen in slice 3; slice 4 builds approvals on top) ----

export const RUN_STATES = ["queued", "leased", "running", "waiting_for_human", "held", "completed", "failed", "cancelled"] as const;
export const RunStateSchema = z.enum(RUN_STATES);
export type RunState = z.infer<typeof RunStateSchema>;
export const TERMINAL_RUN_STATES: ReadonlySet<RunState> = new Set(["completed", "failed", "cancelled"]);

export const RunSchema = z.object({
  invocation_id: IdSchema,
  room_id: IdSchema,
  thread_id: IdSchema,
  bot_id: IdSchema,
  source_message_id: IdSchema,
  state: RunStateSchema,
  attempt: z.number().int().nonnegative(),
  /** Bumped by the server on every revision; older revisions never overwrite newer. */
  revision: z.number().int().nonnegative(),
  host_online: z.boolean(),
  /** Queued while the host is offline expires after 24h as a visible nonstarted failure. */
  queued_expires_at: z.string().nullable().optional(),
  stop_requested: z.boolean().optional(),
  failure: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  card_id: IdSchema.nullable().optional(),
});
export type CloudRun = z.infer<typeof RunSchema>;

export const RoomBotSchema = z.object({ bot_id: IdSchema, name: z.string(), host_online: z.boolean() });
export type RoomBot = z.infer<typeof RoomBotSchema>;

// ---- attachments (slice 4): object key namespace workspace|room|attachment_id ----

export const ATTACHMENT_STATES = ["preparing", "uploading", "verifying", "ready", "rejected", "expired"] as const;
export const AttachmentStateSchema = z.enum(ATTACHMENT_STATES);
export type AttachmentState = z.infer<typeof AttachmentStateSchema>;
export const ATTACHMENT_LIMITS = Object.freeze({ bytes: 25 * 1024 * 1024, perMessage: 32 });
export const AttachmentSchema = z.object({
  attachment_id: IdSchema,
  room_id: IdSchema,
  name: z.string().min(1).max(255),
  content_type: z.string().min(1).max(255),
  size: z.number().int().nonnegative(),
  state: AttachmentStateSchema,
});
export type CloudAttachment = z.infer<typeof AttachmentSchema>;
export const UploadAllocationSchema = z.object({
  attachment: AttachmentSchema,
  upload_url: z.string().min(1),
  upload_expires_at: z.string(),
});

// ---- approval cards (slice 4, extends waiting_for_human) ----

export const CARD_STATES = ["pending", "approved", "denied", "expired", "revoked"] as const;
export const CardStateSchema = z.enum(CARD_STATES);
export const CardSchema = z.object({
  card_id: IdSchema,
  invocation_id: IdSchema,
  room_id: IdSchema,
  thread_id: IdSchema,
  bot_id: IdSchema,
  version: z.number().int().positive(),
  state: CardStateSchema,
  title: z.string(),
  summary: z.string(),
  digest: z.string(),
  expires_at: z.string(),
  decided_by: IdSchema.nullable().optional(),
  /** View and decide are separate capabilities. */
  can_decide: z.boolean(),
});
export type CloudCard = z.infer<typeof CardSchema>;
export type CardDecision = "approve" | "deny";
export const CardDecisionSchema = z.object({
  kind: z.literal("card.decide"),
  client_operation_id: z.string().regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{16,128}$/),
  card_id: IdSchema,
  version: z.number().int().positive(),
  digest: z.string(),
  decision: z.enum(["approve", "deny"]),
});

// ---- room projection extensions (message/snapshot schemas: src/cloud/run-schema.ts) ----

/** Room event kinds added by slices 3/4 (payload `{run}`, `{card}`, `{bot}`). */
export const RUN_EVENT_KINDS = ["run.updated", "card.updated", "bot.host_status"] as const;

/** Ephemeral provisional text; never part of the committed projection. */
export const StreamDeltaFrameSchema = z.object({
  type: z.literal("stream.delta"),
  workspace_id: IdSchema,
  room_id: IdSchema,
  thread_id: IdSchema,
  invocation_id: IdSchema,
  attempt: z.number().int().nonnegative(),
  fence_gen: z.number().int().nonnegative(),
  seq: z.number().int().nonnegative(),
  text: z.string(),
});
export type StreamDeltaFrame = z.infer<typeof StreamDeltaFrameSchema>;

// ---- host wire (host <-> room service, outbound from the mac) ----

const fenced = { invocation_id: IdSchema, attempt: z.number().int().nonnegative(), fence_gen: z.number().int().nonnegative() };

export const InvocationSchema = z.object({
  invocation_id: IdSchema,
  workspace_id: IdSchema,
  room_id: IdSchema,
  thread_id: IdSchema,
  bot_id: IdSchema,
  /** Pinned source version; edits never change it. */
  source: z.object({
    message_id: IdSchema,
    version: z.number().int().positive(),
    actor_id: IdSchema,
    actor_name: z.string().optional(),
    text: z.string(),
    mentions: z.array(MentionSchema),
    sequence: SequenceSchema,
  }),
  model: z.string().nullable().optional(),
});
export type Invocation = z.infer<typeof InvocationSchema>;

export const HostInboundSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("host.ready"), host_id: IdSchema }),
  z.object({ type: z.literal("invocation.offered"), invocation: InvocationSchema, attempt: z.number().int().nonnegative() }),
  z.object({ type: z.literal("invocation.claimed"), ...fenced, lease_expires_at: z.string() }),
  z.object({ type: z.literal("invocation.lease"), ...fenced, lease_expires_at: z.string() }),
  /** Claim lost, lease expired or a newer generation exists: stop and never publish. */
  z.object({ type: z.literal("invocation.fenced"), ...fenced }),
  z.object({ type: z.literal("final.committed"), ...fenced, result_id: IdSchema, message_id: IdSchema }),
  z.object({ type: z.literal("stop.requested"), invocation_id: IdSchema, control_revision: z.number().int().nonnegative() }),
  z.object({ type: z.literal("error"), error: z.string(), invocation_id: IdSchema.optional() }),
]);
export type HostInbound = z.infer<typeof HostInboundSchema>;

export type HostOutbound =
  | { type: "host.authenticate"; host_token: string }
  | { type: "invocation.claim"; invocation_id: string; attempt: number }
  | { type: "invocation.heartbeat"; invocation_id: string; attempt: number; fence_gen: number }
  | { type: "stream.delta"; invocation_id: string; attempt: number; fence_gen: number; seq: number; text: string }
  | { type: "final.commit"; invocation_id: string; attempt: number; fence_gen: number; result_id: string; text: string; model: string | null }
  | { type: "invocation.failed"; invocation_id: string; attempt: number; fence_gen: number; failure: string; model: string | null }
  | { type: "stop.observed"; invocation_id: string; attempt: number; fence_gen: number; control_revision: number };

/** D06/D07 timings, server time. */
export const LEASE = Object.freeze({ ttlMs: 30_000, heartbeatMs: 10_000, queuedExpiryMs: 24 * 60 * 60 * 1000 });
