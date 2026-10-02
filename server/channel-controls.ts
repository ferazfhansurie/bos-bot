import { botAvatarUrlSchema } from "../shared/bot-avatar.ts";

export interface ChannelControls {
  avatarUrl?: string | null;
  memberReplyModes?: Record<string, "always" | "mentions">;
  notifications?: "all" | "mentions" | "muted";
}

/** Validate persisted room controls against the accepted roster, never client hints. */
export function channelControlPatch(
  body: Record<string, unknown>,
  memberIds: string[],
  avatarExists: (url: string) => boolean,
): ChannelControls {
  const patch: ChannelControls = {};
  const fail = (message: string): never => { throw Object.assign(new Error(message), { status: 400 }); };
  if (body.avatarUrl !== undefined) {
    if (body.avatarUrl === null) patch.avatarUrl = null;
    else {
      const parsed = botAvatarUrlSchema.safeParse(body.avatarUrl);
      if (!parsed.success || !avatarExists(parsed.data)) fail("room avatar must be an existing stored image");
      patch.avatarUrl = parsed.data;
    }
  }
  if (body.memberReplyModes !== undefined) {
    const value = body.memberReplyModes;
    if (!value || typeof value !== "object" || Array.isArray(value)) fail("memberReplyModes must be a member map");
    const modes: NonNullable<ChannelControls["memberReplyModes"]> = {};
    for (const [id, mode] of Object.entries(value as Record<string, unknown>)) {
      if (!memberIds.includes(id) || (mode !== "always" && mode !== "mentions")) fail("invalid member reply mode");
      modes[id] = mode as "always" | "mentions";
    }
    patch.memberReplyModes = modes;
  }
  if (body.notifications !== undefined) {
    if (!["all", "mentions", "muted"].includes(body.notifications as string)) fail("invalid room notification setting");
    patch.notifications = body.notifications as ChannelControls["notifications"];
  }
  return patch;
}

/** Approvals and questions always reach the owner, even in a muted room. */
export function roomCompletionNotifies(mode: ChannelControls["notifications"], text: string, ownerName: string): boolean {
  if (mode === "muted") return false;
  if (mode !== "mentions") return true;
  const escaped = ownerName.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return Boolean(escaped && new RegExp(`(?:^|\\s)@${escaped}(?=$|[^a-z0-9])`, "i").test(text));
}
