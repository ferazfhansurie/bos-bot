// Web projection schemas for slices 3/4: committed messages may carry the
// invocation that produced them and their attachments; snapshots carry active
// runs, approval cards and the room's bots (items parsed in runs.ts). Replaced by api's schema on rebase.
import { z } from "zod";
import { BatchSchema, ErrorCodeSchema, MessageSchema, ResetSchema, SnapshotSchema } from "../../shared/cloud-protocol/index";
import { ATTACHMENT_LIMITS, AttachmentSchema, StreamDeltaFrameSchema } from "../../shared/cloud-run-draft";

export const RoomMessageSchema = MessageSchema.extend({
  invocation_id: z.string().nullable().optional(),
  attachments: z.array(AttachmentSchema).max(ATTACHMENT_LIMITS.perMessage).optional(),
});
export type RoomMessage = z.infer<typeof RoomMessageSchema>;

export const RoomSnapshotSchema = SnapshotSchema.extend({
  messages: z.array(RoomMessageSchema).max(50),
  // Parsed item by item in the reducer: one unreadable run never blocks the room.
  active_runs: z.array(z.unknown()),
  cards: z.array(z.unknown()),
  bots: z.array(z.unknown()).optional(),
});
export type RoomSnapshot = z.infer<typeof RoomSnapshotSchema>;

/** Realtime frames: slice 1 frames with run-aware snapshots, plus ephemeral stream deltas. */
export const RoomFrameSchema = z.union([
  BatchSchema,
  ResetSchema.extend({ snapshot: RoomSnapshotSchema.optional() }),
  z.object({ type: z.literal("error"), error: ErrorCodeSchema }).strict(),
  z.object({ type: z.literal("heartbeat") }).strict(),
  StreamDeltaFrameSchema,
]);
export type RoomFrame = z.infer<typeof RoomFrameSchema>;
