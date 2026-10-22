import { z } from "zod";
import { mascotEyesSchema } from "../shared/mascot-eyes.ts";

import { BOT_AVATAR_CROPS, botAvatarCropSchema, botAvatarUrlSchema } from "../shared/bot-avatar.ts";
import { BOT_PROFILE_LIMITS } from "../shared/bot-profile.ts";
import { normalizeMausColor } from "../shared/glyph-faces.ts";
import { MASCOT_BODY_IDS, mascotBodySchema } from "../shared/mascot-bodies.ts";
import type { MausColor } from "../shared/wire.ts";

import type { BotRecord } from "./store.ts";

/** A name or title is quoted inside prompts and cards as one line — a
 * roster entry, a "Name: …" speaker line, the bracketed provenance note.
 * Text that can break out of that line (a newline, a control byte, the
 * Unicode separators) is refused at the door rather than flattened later,
 * so what the person sees in the sidebar is what every prompt sees too.
 * Written as a scan because a control-character class is the kind of
 * literal the linter (rightly) refuses. */
export function fitsOnOneLine(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) return false;
  }
  return true;
}

export const BOT_PROFILE_PATCH_FIELDS = [
  "name",
  "title",
  "description",
  "soul",
  "notifications",
  "avatarUrl",
  "avatarCrop",
  "mascotBody",
  "mascotEyes",
  "color",
  "voice",
  "speakReplies",
  "workContinuity",
] as const;

const COLOR_ERROR = "color must be a palette name or #RRGGBB";

const profilePatchSchema = z.object({
  name: z
    .string({ error: "name must be a string" })
    .max(BOT_PROFILE_LIMITS.name, { error: "name must be at most 100 characters" })
    .refine((value) => Boolean(value.trim()), { error: "name must not be empty" })
    .refine(fitsOnOneLine, { error: "name must fit on one line" })
    .optional(),
  title: z
    .string({ error: "title must be a string" })
    .max(BOT_PROFILE_LIMITS.title, { error: "title must be at most 200 characters" })
    .refine(fitsOnOneLine, { error: "title must fit on one line" })
    .optional(),
  description: z
    .string({ error: "description must be a string" })
    .max(BOT_PROFILE_LIMITS.description, { error: "description must be at most 4000 characters" })
    .optional(),
  soul: z
    .string({ error: "soul must be a string" })
    .refine((value) => Buffer.byteLength(value, "utf8") <= BOT_PROFILE_LIMITS.soul, {
      error: "standing instructions must be at most 24000 bytes",
    })
    .optional(),
  notifications: z.boolean({ error: "notifications must be true or false" }).optional(),
  avatarUrl: z
    .union([botAvatarUrlSchema, z.literal(""), z.null()], {
      error: "avatarUrl must be a stored PNG, JPEG, GIF, or WebP attachment",
    })
    .optional(),
  avatarCrop: botAvatarCropSchema.optional(),
  mascotBody: mascotBodySchema.optional(),
  mascotEyes: mascotEyesSchema.nullable().optional(),
  // Cosmetic, so paired clients may set it; normalized exactly like the
  // broad desktop PATCH (palette name kept, hex uppercased).
  color: z
    .string({ error: COLOR_ERROR })
    .refine((value) => normalizeMausColor(value) !== null, { error: COLOR_ERROR })
    .transform((value) => normalizeMausColor(value) as MausColor)
    .optional(),
  voice: z
    .string({ error: "voice must be a string" })
    .max(BOT_PROFILE_LIMITS.voice, { error: "voice must be at most 200 characters" })
    .optional(),
  workContinuity: z.boolean().optional(),
  speakReplies: z.boolean({ error: "speakReplies must be true or false" }).optional(),
});

export type BotProfilePatchInput = z.input<typeof profilePatchSchema>;

export type BotProfilePatch = Partial<
  Pick<
    BotRecord,
    | "name"
    | "title"
    | "description"
    | "soul"
    | "notifications"
    | "avatarUrl"
    | "avatarCrop"
    | "mascotBody"
    | "mascotEyes"
    | "color"
    | "voice"
    | "speakReplies"
    | "workContinuity"
  >
>;

export type BotProfilePatchResult =
  | { ok: true; patch: BotProfilePatch }
  | { ok: false; error: string };

/**
 * The shared validation boundary for profile fields. The desktop's broad bot
 * PATCH passes strict=false; paired clients use strict=true so a future bot
 * field cannot silently become remotely writable.
 *
 * avatarUrl deliberately uses `undefined` as the normalized clear value.
 * Store persistence already omits undefined fields, while wireBot sends null
 * back to clients so Codable and object-spread clients both clear stale data.
 */
export function parseBotProfilePatch(input: unknown, strict = false): BotProfilePatchResult {
  const parsed = (strict ? profilePatchSchema.strict() : profilePatchSchema).safeParse(input);
  if (!parsed.success) {
    const unsupported = parsed.error.issues.find((issue) => issue.code === "unrecognized_keys");
    if (unsupported?.code === "unrecognized_keys") {
      return { ok: false, error: `unsupported profile field: ${unsupported.keys[0] ?? "unknown"}` };
    }
    const issue = parsed.error.issues[0];
    if (issue?.path[0] === "avatarCrop") {
      const options = `${BOT_AVATAR_CROPS.slice(0, -1).join(", ")}, or ${BOT_AVATAR_CROPS.at(-1)}`;
      return { ok: false, error: `avatarCrop must be ${options}` };
    }
    if (issue?.path[0] === "mascotBody") {
      const options = `${MASCOT_BODY_IDS.slice(0, -1).join(", ")}, or ${MASCOT_BODY_IDS.at(-1)}`;
      return { ok: false, error: `mascotBody must be ${options}` };
    }
    return { ok: false, error: issue?.message ?? "invalid profile patch" };
  }

  const { avatarUrl, ...fields } = parsed.data;
  const patch: BotProfilePatch = fields;
  if (avatarUrl !== undefined) patch.avatarUrl = avatarUrl || undefined;
  return { ok: true, patch };
}
