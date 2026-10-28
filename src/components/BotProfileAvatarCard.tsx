import { useEffect, useRef, useState } from "react";
import { ImagePlus, Loader2, Trash2 } from "lucide-react";

import { api, useStore, type Bot } from "@/state/store";
import { imageAttachmentFromFile } from "@/lib/composer-attachments";
import { cn } from "@/lib/cn";
import {
  MAUS_COLORS,
  MAUS_COLOR_NAMES,
  type MausColor,
  type MausMotion,
  type MausState,
} from "@/lib/mascot";
import { resolveMausColor } from "../../shared/glyph-faces";
import { createColorPickCommitter } from "@/lib/color-pick-commit";
import {
  BOT_AVATAR_CROPS,
  botAvatarUrlFromStoredPath,
  type BotAvatarCrop,
} from "../../shared/bot-avatar";
import { FLAT_MASCOT_BODIES, FLAT_MASCOT_GROUPS, flatMascotBody } from "../../shared/flat-mascot-bodies";
import { BotAvatar, MausAvatar } from "./Avatar";
import { AvatarImageGenerator } from "./AvatarImageGenerator";
import { useOrganizationBranding } from "@/lib/use-organization-branding";
import { useV3 } from "@/lib/v3";
import { MascotAccessoryPicker } from "./MascotAccessoryPicker";

type AvatarPatch = Partial<
  Pick<Bot, "avatarCrop" | "avatarUrl" | "color" | "mascotExpression" | "mascotBody" | "mascotAccessories">
>;

const CROP_LABEL = {
  mascot: "Mascot",
  circle: "Circle",
  rounded: "Rounded",
  square: "Square",
} satisfies Record<BotAvatarCrop, string>;

export function BotProfileAvatarCard({
  bot,
  activeState,
  mascotMotion,
  onPatch,
}: {
  bot: Bot;
  activeState: MausState;
  mascotMotion: { kind: Exclude<MausMotion, "none">; nonce: number } | null;
  onPatch: (patch: AvatarPatch) => void;
}) {
  const { flushBotPatches } = useStore();
  const organization = useOrganizationBranding();
  const v3 = useV3();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [savingConnection, setSavingConnection] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const crop = bot.avatarCrop ?? "mascot";
  const cropRef = useRef(crop);
  cropRef.current = crop;
  const busy = uploading || generating || savingConnection;
  // the free colour while the system picker is open; saved when it closes
  const [draftColor, setDraftColor] = useState<MausColor | null>(null);
  const shownBot = draftColor ? { ...bot, color: draftColor } : bot;

  const upload = async (file: File | undefined) => {
    if (!file || busy) return;
    setUploading(true);
    setError(null);
    try {
      const saved = await imageAttachmentFromFile(file);
      if (!saved) throw new Error("Choose a PNG, JPEG, GIF, or WebP image");
      const avatarUrl = botAvatarUrlFromStoredPath(saved.path);
      if (!avatarUrl) throw new Error("The uploaded image could not be used as an avatar");
      const latestCrop = cropRef.current;
      onPatch({ avatarUrl, avatarCrop: latestCrop === "mascot" ? "circle" : latestCrop });
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : String(uploadError));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const removeImage = () => {
    setError(null);
    onPatch({ avatarUrl: null, avatarCrop: "mascot" });
  };

  const generate = async (direction: string) => {
    if (busy) return;
    setGenerating(true);
    setError(null);
    try {
      // Generation reads the bot's identity and crop server-side. Commit any
      // debounced profile edits first, then feed the generated avatar back
      // through the same serialized mutation lane as upload/remove.
      const cropAtStart = cropRef.current;
      await flushBotPatches(bot.id);
      const result: { avatarUrl: string; bot: Bot } = await api(`/api/bots/${bot.id}/avatar/generate`, {
        method: "POST",
        body: JSON.stringify({ prompt: direction.trim() }),
      });
      const latestCrop = cropRef.current;
      onPatch({
        avatarUrl: result.avatarUrl,
        // The server owns this crop for generate (server/index.ts picks
        // "circle" for a mascot bot). The fallback below is never actually
        // reached, since the server always assigns a crop; "circle" is kept
        // only as the truthful default if it ever were.
        avatarCrop:
          latestCrop === cropAtStart
            ? (result.bot.avatarCrop ?? "circle")
            : latestCrop,
      });
    } catch (generateError) {
      setError(generateError instanceof Error ? generateError.message : String(generateError));
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="overflow-hidden rounded-xl border border-hairline/40 bg-card">
      <div className="flex items-center justify-between border-b border-hairline/40 px-3 py-2.5">
        <span className="rounded-lg bg-control px-3 py-1.5 text-[14px] font-medium text-ink">Avatar</span>
        <button
          disabled={busy}
          onClick={() => onPatch({ avatarCrop: "mascot", color: "green", mascotExpression: null, mascotBody: "circle", ...(v3 ? { mascotAccessories: null } : {}) })}
          className="rounded-md px-2 py-1.5 text-[13px] text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-50"
        >
          Reset mascot
        </button>
      </div>

      <div className="p-3">
        {Boolean(organization?.icons.length) && <div className="mb-3 border-b border-hairline/40 pb-3">
          <div className="mb-2 text-[13px] font-medium text-ink-secondary">{organization!.name} icons</div>
          <div className="flex flex-wrap gap-2">{organization!.icons.map(icon => <button key={icon.id} type="button" disabled={busy} title={icon.name} aria-label={`Use ${icon.name} icon`} className="flex size-12 items-center justify-center rounded-lg border border-hairline/40 hover:bg-control disabled:opacity-50" onClick={() => {
            // Use the normal attachment path, so chosen icons survive removal
            // from Admin and travel with the user's own workspace backups.
            const bytes = Uint8Array.from(atob(icon.image.slice(22)), byte => byte.charCodeAt(0));
            void upload(new File([bytes], `${icon.id}.png`, { type: "image/png" }));
          }}><img src={icon.image} alt="" className="size-10 rounded-md object-contain" /></button>)}</div>
        </div>}
        <div className="flex justify-center py-3">
          <BotAvatar
            bot={shownBot}
            state={activeState}
            size={112}
            motion={mascotMotion?.kind ?? "none"}
            motionKey={mascotMotion?.nonce ?? 0}
          />
        </div>

        <div className="mt-2 flex gap-2">
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            className="sr-only"
            onChange={(event) => void upload(event.target.files?.[0])}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
          >
            {uploading ? <Loader2 size={14} className="animate-spin" /> : <ImagePlus size={14} />}
            Upload image
          </button>
          {bot.avatarUrl && (
            <button
              type="button"
              onClick={removeImage}
              disabled={busy}
              aria-label="Remove custom avatar image"
              title="Remove custom image"
              className="flex size-10 items-center justify-center rounded-lg text-ink-secondary hover:bg-control hover:text-danger disabled:opacity-50"
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
        <div className="mt-1.5 text-[11.5px] text-ink-secondary">PNG, JPEG, GIF, or WebP · up to 10 MB</div>

        <div className="mb-2 mt-4 text-[12px] font-medium uppercase tracking-[0.08em] text-ink-secondary">
          Shape
        </div>
        <div className="grid grid-cols-4 overflow-hidden rounded-lg border border-hairline/40">
          {BOT_AVATAR_CROPS.map((candidate, index) => (
            <button
              key={candidate}
              type="button"
              disabled={busy}
              aria-pressed={crop === candidate}
              onClick={() => onPatch({ avatarCrop: candidate })}
              className={cn(
                "py-1.5 text-[12.5px] disabled:opacity-50",
                index > 0 && "border-l border-hairline/40",
                crop === candidate ? "bg-control text-ink" : "text-ink-secondary hover:bg-control/60 hover:text-ink",
              )}
            >
              {CROP_LABEL[candidate]}
            </button>
          ))}
        </div>

        {crop === "mascot" && (
          <>
            <div className="mb-2 mt-4 text-[12px] font-medium uppercase tracking-[0.08em] text-ink-secondary">
              Color
            </div>
            <div className="flex flex-wrap gap-2.5">
              {MAUS_COLOR_NAMES.map((color) => (
                <button
                  key={color}
                  type="button"
                  disabled={busy}
                  aria-pressed={bot.color === color}
                  onClick={() => onPatch({ color })}
                  className={cn(
                    "size-10 rounded-full border-2 border-transparent transition-transform hover:scale-110 disabled:opacity-50",
                    bot.color === color && "ring-2 ring-accent-border ring-offset-2 ring-offset-card",
                  )}
                  style={{ backgroundColor: MAUS_COLORS[color] }}
                  title={color}
                  aria-label={`Use ${color} mascot color`}
                />
              ))}
              <CustomColorSwatch
                color={bot.color}
                disabled={busy}
                onDraft={setDraftColor}
                onPick={(color) => {
                  setDraftColor(null);
                  if (color !== bot.color) onPatch({ color });
                }}
              />
            </div>

            <div className="mb-2 mt-4 text-[12px] font-medium uppercase tracking-[0.08em] text-ink-secondary">
              Body
            </div>
            {FLAT_MASCOT_GROUPS.map(group => (
              <div key={group} className="mb-4 last:mb-0">
                <div className="mb-2 text-[12px] text-ink-secondary">{group}</div>
                <div className="grid grid-cols-4 gap-2">
                  {FLAT_MASCOT_BODIES.filter(body => body.group === group).map(body => (
                    <button
                      key={body.id}
                      type="button"
                      disabled={busy}
                      aria-pressed={flatMascotBody(bot.mascotBody).id === body.id}
                      aria-label={`Use the ${body.name} body`}
                      onClick={() => onPatch({ mascotBody: body.id })}
                      className={cn(
                        "flex min-w-0 flex-col items-center justify-center rounded-lg px-1 py-2 disabled:opacity-50",
                        flatMascotBody(bot.mascotBody).id === body.id
                          ? "bg-control text-ink ring-1 ring-accent-border"
                          : "text-ink-secondary hover:bg-control/60",
                      )}
                    >
                      <MausAvatar color={shownBot.color} eyes={bot.mascotEyes} bodyId={body.id} size={52} animated={false} trackPointer={false} />
                      <span className="mt-1 max-w-full break-words text-center text-[11px] leading-tight">{body.name}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}

            {v3 && (
              <MascotAccessoryPicker
                color={shownBot.color}
                bodyId={flatMascotBody(bot.mascotBody).id}
                eyes={bot.mascotEyes}
                value={bot.mascotAccessories}
                disabled={busy}
                onChange={mascotAccessories => onPatch({ mascotAccessories })}
              />
            )}
          </>
        )}

        <AvatarImageGenerator
          botLabel={bot.title || bot.name}
          disabled={uploading}
          generating={generating}
          onGenerate={generate}
          onSavingChange={setSavingConnection}
        />

        {error && <div role="alert" className="mt-3 text-[12px] text-danger">{error}</div>}
      </div>
    </div>
  );
}

/** Any colour, past the 13 presets: the system colour picker behind a
 * swatch. It previews live while the picker is open and saves once the
 * person pauses, the picker closes, or the swatch loses focus — so dragging
 * across the wheel is a handful of saves, not hundreds.
 *
 * The input holds its own draft value. Controlled by the saved colour alone,
 * React restores the old value right after every input event, so by the
 * time "change" fired the input read back the old colour and nothing new
 * was ever saved (and the restore also snapped the open macOS panel back). */
function CustomColorSwatch({ color, disabled, onDraft, onPick }: {
  color: MausColor;
  disabled: boolean;
  onDraft: (color: MausColor) => void;
  onPick: (color: MausColor) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const custom = !Object.hasOwn(MAUS_COLORS, color);
  const saved = resolveMausColor(color);
  const [draft, setDraft] = useState<string | null>(null);
  const latest = useRef({ onPick, saved });
  latest.current = { onPick, saved };
  const [committer] = useState(() =>
    createColorPickCommitter({
      saved: () => latest.current.saved,
      save: (value) => latest.current.onPick(value as MausColor),
    }),
  );
  // Once the saved colour moves (our save landing, or another client) and
  // nothing is waiting to be saved, show it instead of a stale draft.
  useEffect(() => {
    if (!committer.pending()) setDraft(null);
  }, [saved, committer]);
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    // React's onChange is the input event; "change" is the picker closing
    const commit = () => {
      committer.draft(el.value);
      committer.flush();
    };
    el.addEventListener("change", commit);
    return () => {
      el.removeEventListener("change", commit);
      // closing the panel mid-drag still saves the last colour shown
      committer.flush();
    };
  }, [committer]);
  return (
    <label
      title="Any colour"
      className={cn(
        "relative size-10 cursor-pointer overflow-hidden rounded-full border-2 border-transparent transition-transform hover:scale-110",
        disabled && "pointer-events-none opacity-50",
        custom && "ring-2 ring-accent-border ring-offset-2 ring-offset-card",
      )}
      style={{
        background: custom || draft
          ? draft ?? saved
          : "conic-gradient(#D94B52, #D8A729, #009957, #0EA5C6, #377FE6, #8057C8, #D84F8B, #D94B52)",
      }}
    >
      <input
        ref={input}
        type="color"
        disabled={disabled}
        aria-label="Pick any mascot color"
        value={(draft ?? saved).toLowerCase()}
        onChange={(event) => {
          const value = event.currentTarget.value.toUpperCase();
          setDraft(value);
          onDraft(value as MausColor);
          committer.draft(value);
        }}
        onBlur={() => committer.flush()}
        className="absolute inset-0 size-full cursor-pointer opacity-0"
      />
    </label>
  );
}
