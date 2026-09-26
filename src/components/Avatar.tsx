import {
  forwardRef,
  memo,
  useEffect,
  useImperativeHandle,
  useState,
} from "react";
import { MAUS_COLORS, type MausColor, type MausMotion, type MausState } from "@/lib/mascot";
import { botAvatarProfile, type BotAvatarCrop } from "../../shared/bot-avatar";
import { type MascotBodyId } from "../../shared/mascot-bodies";

export const EYE_SCALE = 1.12;
export const MOUTH_WEIGHT = 11;

/**
 * How far the pointer may pull the eyes. Facing forward the full range is
 * safe; with the expressions' authored gaze they already start off-centre.
 */
export interface MausAvatarHandle {
  blink(): void;
  spin(durationMs?: number): void;
  setExpression(index: number): void;
}

export type MausAvatarProps = {
  color: MausColor;
  /** Named behaviour — drives the expression pool, its cadence and blinking. */
  state?: MausState;
  /** Pin one of the 25 faces and stop the state's own drift. */
  expression?: number;
  size?: number;
  label?: string;
  motion?: MausMotion;
  motionKey?: number;
  /** Head turn in degrees. */
  turn?: number;
  gaze?: { x?: number; y?: number };
  spring?: number;
  eyeScale?: number;
  showMouth?: boolean;
  mouthStroke?: number;
  /**
   * Face the viewer at turn 0, cancelling each expression's authored gaze
   * direction. Off restores the engine's own drawn-in directions.
   */
  forward?: boolean;
  /** How much each expression glances around. Overrides `forward`'s 0-or-1. */
  lookAround?: number;
  /** Let the eyes follow the pointer across this avatar. */
  trackPointer?: boolean;
  /** Run the animation. Off renders the state's resting face. */
  animated?: boolean;
  /** Which body the bot wears. Unknown values fall back to the cursor. */
  bodyId?: MascotBodyId;
};

// Flat silhouettes retain the persisted body ids, so existing profiles keep working.
const BODY_PATHS: Record<MascotBodyId, string> = {
  "circle": "M 50 10 C 72 10 90 28 90 50 C 90 72 72 90 50 90 C 28 90 10 72 10 50 C 10 28 28 10 50 10 Z",
  "blob": "M 51 12 C 75 8 88 32 90 53 C 91 77 69 91 47 88 C 22 87 8 70 11 50 C 14 30 29 15 51 12 Z",
  "squircle": "M 31 14 C 42 12 61 12 71 14 C 83 15 86 21 87 33 C 89 44 89 62 87 73 C 86 84 80 87 68 88 C 55 89 40 89 28 87 C 17 86 14 79 13 67 C 12 53 12 40 14 28 C 15 18 20 15 31 14 Z",
  "capsule": "M 34 22 C 14 22 7 33 7 50 C 7 67 18 78 34 78 C 45 78 60 78 69 78 C 87 78 94 66 94 50 C 94 33 83 22 67 22 Z",
  "cursor": "M 44 12 C 47 7 53 7 57 13 C 66 27 80 51 90 72 C 95 83 89 88 79 88 C 60 89 37 89 20 88 C 8 88 6 82 12 72 C 22 51 35 27 44 12 Z",
  "hexagon": "M 45 10 C 48 8 52 8 55 10 C 63 14 73 20 82 26 C 86 28 87 31 87 36 C 87 45 87 58 87 65 C 87 70 85 73 81 75 C 72 80 62 86 55 90 C 52 92 48 92 45 90 C 35 85 26 79 18 74 C 14 72 13 69 13 64 C 13 54 13 44 13 35 C 13 30 15 28 19 25 Z",
  "star": "M 20 38 C 17 17 42 3 57 17 C 74 7 89 21 87 39 C 108 57 94 83 74 82 C 61 97 40 97 27 84 C 3 90 -3 58 20 38 Z",
  "drop": "M 46 9 C 49 5 52 6 55 10 C 64 21 87 46 87 64 C 87 84 71 95 51 95 C 29 95 14 81 15 63 C 16 46 37 20 46 9 Z",
  "shield": "M 45 10 C 48 8 52 8 55 10 C 63 14 73 20 82 26 C 86 28 87 31 87 36 C 87 45 87 58 87 65 C 87 70 85 73 81 75 C 72 80 62 86 55 90 C 52 92 48 92 45 90 C 35 85 26 79 18 74 C 14 72 13 69 13 64 C 13 54 13 44 13 35 C 13 30 15 28 19 25 Z",
  "diamond": "M 31 14 C 42 12 61 12 71 14 C 83 15 86 21 87 33 C 89 44 89 62 87 73 C 86 84 80 87 68 88 C 55 89 40 89 28 87 C 17 86 14 79 13 67 C 12 53 12 40 14 28 C 15 18 20 15 31 14 Z"
};

function MausAvatarComponent(
  { size = 44, label, color, bodyId = "circle", 
    animated = true, trackPointer = true, gaze, turn = 0 }: MausAvatarProps,
  ref: React.Ref<MausAvatarHandle>,
) {

  const [blinkKey, setBlinkKey] = useState(0);
  const [spinKey, setSpinKey] = useState(0);
  const [pointer, setPointer] = useState({ x: 0, y: 0 });
  useImperativeHandle(ref, () => ({
    blink: () => setBlinkKey(k => k + 1),
    spin: () => setSpinKey(k => k + 1),
    setExpression: () => undefined,
  }));
  const face = "idle";
  const eyes = ["M 51 43 L 54 52", "M 73 39 L 76 48"];
  return (
    <svg width={size} height={size} viewBox="0 0 100 100"
      role="img" aria-label={label ?? `${bodyId} ${face} bot`}
      className="inline-block shrink-0" style={{ overflow: "visible" }}
      onPointerMove={animated && trackPointer ? event => {
        const r = event.currentTarget.getBoundingClientRect();
        setPointer({ x: ((event.clientX-r.left)/r.width-.5)*5, y: ((event.clientY-r.top)/r.height-.5)*5 });
      } : undefined}
      onPointerLeave={() => setPointer({ x: 0, y: 0 })}>
      <g key={spinKey} className={animated && spinKey ? "bos-avatar-spin" : undefined} style={{ transformOrigin: "50px 50px" }}>
        <path d={BODY_PATHS[bodyId] ?? BODY_PATHS.circle} fill={MAUS_COLORS[color] ?? "#808080"} />
        <g transform={`translate(${pointer.x + (gaze?.x ?? 0)*3} ${pointer.y + (gaze?.y ?? 0)*3}) rotate(${turn} 50 50)`}>
          <g key={blinkKey} className={animated && blinkKey ? "bos-avatar-blink" : undefined} style={{ transformOrigin: "50px 48px" }}
            fill="none" stroke="#151515" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round">
            <path d={eyes[0]} /><path d={eyes[1]} />
          </g>
        </g>
      </g>
    </svg>
  );
}

export const MausAvatar = memo(forwardRef(MausAvatarComponent));

export type BotAvatarProps = Omit<MausAvatarProps, "color"> & {
  bot: {
    name?: string;
    color: MausColor;
    avatarUrl?: string | null;
    avatarCrop?: BotAvatarCrop;
    mascotBody?: MascotBodyId | null;
  };
};

export type BotAvatarOutcome = "flatImage" | "gradientMascot";

/**
 * Pick which of the two ways to render a bot's avatar, given the parsed
 * profile plus whether the image has already failed to load. Kept as a pure
 * function — independent of React state and effects — so both arms can be
 * unit-tested directly: `imageFailed` is set by the `<img>`'s own `onError`,
 * which `renderToStaticMarkup` never fires, so the failure fallback is
 * unreachable from a synchronous render test.
 *
 * The iOS half of this decision is `resolveBotAvatarOutcome` in
 * `ios/Sources/CompanionCore/BotAvatarRendering.swift`, which mirrors this
 * union name for name so the two renderers can be read side by side.
 */
export function resolveBotAvatarOutcome(params: {
  avatarCrop: BotAvatarCrop;
  hasUrl: boolean;
  imageFailed: boolean;
}): BotAvatarOutcome {
  const { avatarCrop, hasUrl, imageFailed } = params;
  if (!hasUrl) return "gradientMascot";
  if (avatarCrop === "mascot") return "gradientMascot";
  if (imageFailed) return "gradientMascot";
  return "flatImage";
}

/**
 * The one renderer for a bot's chosen profile image. Malformed persisted
 * values and images that fail to load both fall back to the animated mascot,
 * so an old/corrupt profile can never leave a broken-image icon in the app.
 */
export function BotAvatar({ bot, size = 44, label, ...mascotProps }: BotAvatarProps) {
  const profile = botAvatarProfile(bot);
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => setImageFailed(false), [profile.avatarUrl]);

  const outcome = resolveBotAvatarOutcome({
    avatarCrop: profile.avatarCrop,
    hasUrl: Boolean(profile.avatarUrl),
    imageFailed,
  });

  if (outcome !== "flatImage") {
    return (
      <MausAvatar
        bodyId={bot.mascotBody ?? undefined}
        {...mascotProps}
        color={bot.color}
        size={size}
        label={label ?? bot.name}
      />
    );
  }

  const radius =
    profile.avatarCrop === "circle"
      ? "50%"
      : profile.avatarCrop === "rounded"
        ? "22%"
        : "0";
  return (
    <img
      src={profile.avatarUrl}
      alt={label ?? (bot.name ? `${bot.name} avatar` : "Bot avatar")}
      width={size}
      height={size}
      draggable={false}
      onError={() => setImageFailed(true)}
      className="block shrink-0 bg-raised object-cover"
      style={{ width: size, height: size, borderRadius: radius }}
    />
  );
}

export function InitialsAvatar({
  initials,
  size = 32,
}: {
  initials: string;
  size?: number;
}) {
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-full bg-raised text-ink-secondary font-medium"
      style={{ width: size, height: size, fontSize: size * 0.38 }}
    >
      {initials}
    </div>
  );
}

const cutouts = new Map<string, Promise<string>>();

/** A person's photo with its plain backdrop removed: light pixels reachable
 * from the image border turn transparent (a flood fill, so a white face or
 * shirt inside the outline stays), and the picture sits on the sidebar like
 * a bot mascot does instead of in a white disc. Falls back to the original. */
function cutout(src: string): Promise<string> {
  const cached = cutouts.get(src);
  if (cached) return cached;
  const started = new Promise<string>((resolve) => {
    const image = new Image();
    image.onerror = () => resolve(src);
    image.onload = () => {
      try {
        const scale = Math.min(1, 256 / Math.max(image.naturalWidth, image.naturalHeight));
        const width = Math.max(1, Math.round(image.naturalWidth * scale));
        const height = Math.max(1, Math.round(image.naturalHeight * scale));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        if (!context) return resolve(src);
        context.drawImage(image, 0, 0, width, height);
        const data = context.getImageData(0, 0, width, height);
        const pixels = data.data;
        const total = width * height;
        // Backdrop: light, near-grey pixels, which also covers a checkerboard
        // "transparency" pattern baked into a JPEG.
        const light = (at: number) => {
          const r = pixels[at * 4]!, g = pixels[at * 4 + 1]!, b = pixels[at * 4 + 2]!;
          return Math.min(r, g, b) > 185 && Math.max(r, g, b) - Math.min(r, g, b) < 14;
        };
        const backdrop = new Uint8Array(total);
        const seen = new Uint8Array(total);
        const stack: number[] = [];
        for (let x = 0; x < width; x++) stack.push(x, (height - 1) * width + x);
        for (let y = 0; y < height; y++) stack.push(y * width, y * width + width - 1);
        while (stack.length) {
          const at = stack.pop()!;
          if (seen[at]) continue;
          seen[at] = 1;
          // Already-transparent corners (a round photo) pass the fill on.
          if (pixels[at * 4 + 3]! > 0 && !light(at)) continue;
          backdrop[at] = 1;
          const x = at % width;
          if (x > 0) stack.push(at - 1);
          if (x < width - 1) stack.push(at + 1);
          if (at >= width) stack.push(at - width);
          if (at < width * (height - 1)) stack.push(at + width);
        }
        // Close the subject (grow, then shrink, by a small disc) so thin white
        // details that touch the backdrop, like glasses frames, stay.
        const radius = 4;
        const morph = (mask: Uint8Array, grow: boolean) => {
          const out = new Uint8Array(total);
          for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
              let value = grow ? 0 : 1;
              search: for (let dy = -radius; dy <= radius; dy++) {
                const yy = y + dy;
                if (yy < 0 || yy >= height) continue;
                for (let dx = -radius; dx <= radius; dx++) {
                  const xx = x + dx;
                  if (xx < 0 || xx >= width || dx * dx + dy * dy > radius * radius) continue;
                  const on = mask[yy * width + xx] === 1;
                  if (grow && on) { value = 1; break search; }
                  if (!grow && !on) { value = 0; break search; }
                }
              }
              out[y * width + x] = value;
            }
          }
          return out;
        };
        const subject = new Uint8Array(total);
        for (let at = 0; at < total; at++) subject[at] = backdrop[at] ? 0 : 1;
        const kept = morph(morph(subject, true), false);
        let cleared = 0;
        for (let at = 0; at < total; at++) {
          if (kept[at]) continue;
          pixels[at * 4 + 3] = 0;
          cleared++;
        }
        if (cleared === 0) return resolve(src);
        context.putImageData(data, 0, 0);
        resolve(canvas.toDataURL("image/png"));
      } catch {
        resolve(src);
      }
    };
    image.src = src;
  });
  cutouts.set(src, started);
  return started;
}

export function PersonPhoto({ src, size, className = "", testId }: { src: string; size: number; className?: string; testId?: string }) {
  const [shown, setShown] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setShown(null);
    void cutout(src).then((next) => { if (alive) setShown(next); });
    return () => { alive = false; };
  }, [src]);
  return (
    <img
      src={shown ?? src}
      alt=""
      draggable={false}
      data-testid={testId}
      className={`block shrink-0 object-contain ${shown ? "" : "rounded-full"} ${className}`}
      style={{ width: size, height: size }}
    />
  );
}

export interface GroupMarkMember { id: string; name: string; kind: "person" | "bot"; avatar?: string | null; color?: string | null; mascotBody?: string | null }

/** A group's face: up to three members overlapping, bare like the mascots
 * themselves. With three, one sits on top and two in front; with two, one
 * back-left and one front-right. */
export function GroupMark({ members, size }: { members: GroupMarkMember[]; size: number }) {
  const shown = members.slice(0, 3);
  const face = (member: GroupMarkMember, px: number) => member.kind === "person"
    ? member.avatar ? <PersonPhoto src={member.avatar} size={px} />
      : <span style={{ width: px, height: px, fontSize: px * 0.42 }} className="flex items-center justify-center rounded-full bg-accent/20 font-semibold text-accent">{member.name.slice(0, 1).toUpperCase()}</span>
    : <MausAvatar color={Object.hasOwn(MAUS_COLORS, member.color ?? "") ? member.color as MausColor : "green"}
        bodyId={(member.mascotBody ?? undefined) as MascotBodyId | undefined} size={px} animated={false} label={member.name} />;
  if (shown.length <= 1) {
    return <span className="relative block shrink-0" style={{ width: size, height: size }}>{shown[0] && face(shown[0], size)}</span>;
  }
  const slots = shown.length === 2
    ? [{ x: 0, y: 0.06, s: 0.66 }, { x: 0.36, y: 0.32, s: 0.64 }]
    : [{ x: 0.24, y: 0, s: 0.52 }, { x: 0, y: 0.44, s: 0.54 }, { x: 0.46, y: 0.44, s: 0.54 }];
  return (
    <span className="relative block shrink-0" style={{ width: size, height: size }}>
      {shown.map((member, index) => (
        <span key={member.id} className="absolute" style={{ left: slots[index]!.x * size, top: slots[index]!.y * size, zIndex: index + 1 }}>
          {face(member, Math.round(slots[index]!.s * size))}
        </span>
      ))}
    </span>
  );
}
