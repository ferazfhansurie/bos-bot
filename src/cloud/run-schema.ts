// Web projection schemas for slices 3/4: committed messages may carry the
// invocation that produced them and their attachments; snapshots carry active
// runs, approval cards and the room's bots. Replaced by api's schema on rebase.
import { z } from "zod";
import { MessageSchema, SnapshotSchema } from "../../shared/cloud-protocol/index";
import { ATTACHMENT_LIMITS, AttachmentSchema, CardSchema, RoomBotSchema, RunSchema } from "../../shared/cloud-run-draft";

export const RoomMessageSchema = MessageSchema.extend({
  invocation_id: z.string().nullable().optional(),
  attachments: z.array(AttachmentSchema).max(ATTACHMENT_LIMITS.perMessage).optional(),
});
export type RoomMessage = z.infer<typeof RoomMessageSchema>;

export const RoomSnapshotSchema = SnapshotSchema.extend({
  messages: z.array(RoomMessageSchema).max(50),
  active_runs: z.array(RunSchema),
  cards: z.array(CardSchema),
  bots: z.array(RoomBotSchema).optional(),
});
export type RoomSnapshot = z.infer<typeof RoomSnapshotSchema>;
