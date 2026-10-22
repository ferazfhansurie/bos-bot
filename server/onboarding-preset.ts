// A setup preset: one person's first BOS, prepared before they install.
// The desktop opens bosbot://setup?for=<token>, claims the preset from
// app.bosbot.my and posts it here once (electron/preset-link.mjs). The first
// bot learns who the person is and how to help them (a marked block in its
// soul, memory notes, skills), the greeting becomes the prepared one, and the
// apps the preset names are offered as ordinary connector cards. Connecting
// one resumes the bot, and the soul says what to do first with it.
import { z } from "zod";

export const PRESET_SOUL_START = "<!-- bos preset: set up for you before install -->";
export const PRESET_SOUL_END = "<!-- /bos preset -->";

const slug = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,40}$/);

export const presetSchema = z.object({
  id: z.string().regex(/^[\w-]{1,40}$/),
  personName: z.string().trim().max(40).optional(),
  soul: z.string().max(12_000).optional(),
  memory: z.array(z.object({
    path: z.string().regex(/^(MEMORY\.md|memory\/[a-z0-9][a-z0-9-]{0,60}\.md)$/),
    text: z.string().min(1).max(24_000),
  }).strict()).max(6).optional(),
  skills: z.array(z.object({
    name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64),
    md: z.string().min(1).max(24_000),
  }).strict()).max(4).optional(),
  prepared: z.object({
    profile: z.array(z.object({ label: z.string().trim().min(1).max(40), value: z.string().max(600) }).strict()).max(12),
    team: z.array(z.object({ name: z.string().trim().min(1).max(40), job: z.string().trim().min(1).max(240) }).strict()).max(8),
    firstJob: z.object({ title: z.string().trim().min(1).max(80), prompt: z.string().trim().min(1).max(4000) }).strict().optional(),
  }).strict(),
  /** Apps offered after the greeting, each with the line that asks for it. */
  connect: z.array(z.object({ slug, text: z.string().trim().min(1).max(600) }).strict()).max(3).optional(),
  /** The account the person already pays for: the first bot starts on that
   * engine, so turn 1 waits for that sign-in instead of failing on another. */
  engine: z.enum(["codex", "claude"]).optional(),
}).strict();

export type SetupPreset = z.infer<typeof presetSchema>;

export function parsePreset(value: unknown): { ok: true; preset: SetupPreset } | { ok: false; error: string } {
  const parsed = presetSchema.safeParse(value);
  if (parsed.success) return { ok: true, preset: parsed.data };
  const issue = parsed.error.issues[0];
  return { ok: false, error: `invalid setup preset${issue ? ` (${issue.path.join(".") || "body"}: ${issue.message})` : ""}` };
}

/** The soul with the preset block replaced, or added on top. Text the person
 * wrote outside the block stays as it is, so applying twice changes nothing. */
export function soulWithPreset(soul: string, block: string): string {
  const text = block.trim();
  const wrapped = text ? `${PRESET_SOUL_START}\n${text}\n${PRESET_SOUL_END}` : "";
  const start = soul.indexOf(PRESET_SOUL_START);
  const end = soul.indexOf(PRESET_SOUL_END);
  if (start >= 0 && end > start) return `${soul.slice(0, start)}${wrapped}${soul.slice(end + PRESET_SOUL_END.length)}`.trim();
  return text ? (soul.trim() ? `${wrapped}\n\n${soul.trim()}` : wrapped) : soul;
}

/** The driver a preset's engine names. */
export const presetEngineDriver = (engine: NonNullable<SetupPreset["engine"]>) => engine === "claude" ? "claudeAgent" : "codex";

/** The resume key of a preset's connector card, unique per app. */
export const presetResumeKey = (app: string) => `preset-${app}`;
