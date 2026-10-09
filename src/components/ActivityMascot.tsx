// The live-turn mascot: Firaz's approved full-body study, the same engine and
// settings as /mascot-preview.html. A bot with an uploaded photo keeps its
// photo and the breathing squash instead; a photo has no body to morph.
import { useEffect, useMemo, useRef, useState } from "react";
import { CursorAvatar, FACE_BOX, type CursorState } from "./CursorAvatar";
import { BotAvatar, resolveBotAvatarOutcome, type BotAvatarProps } from "./Avatar";
import { glyphFaceParts } from "@/lib/glyph-face";
import { botAvatarProfile } from "../../shared/bot-avatar";
import { flatMascotBody } from "../../shared/flat-mascot-bodies";
import { glyphStateFor, resolveMausColor } from "../../shared/glyph-faces";
import { botMascotEyes } from "../../shared/mascot-eyes";
import type { MascotGesture } from "../../shared/mascot-choreography";

const FACES: Record<MascotGesture, CursorState> = {
  idle: "idle", thinking: "thinking", searching: "searching", working: "working", waiting: "curious", finished: "happy",
};

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => globalThis.window?.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
  useEffect(() => {
    const media = globalThis.window?.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!media) return;
    const change = () => setReduced(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  return reduced;
}

export function ActivityMascot({ bot, gesture, size = 36 }: {
  bot: BotAvatarProps["bot"];
  gesture: MascotGesture;
  size?: number;
}) {
  const host = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(true);
  const [active, setActive] = useState(() => typeof document === "undefined" || !document.hidden);
  const reduced = useReducedMotion();
  useEffect(() => {
    const change = () => setActive(!document.hidden);
    document.addEventListener("visibilitychange", change);
    const observer = typeof IntersectionObserver === "function"
      ? new IntersectionObserver(([entry]) => setVisible(entry?.isIntersecting ?? true))
      : null;
    if (host.current) observer?.observe(host.current);
    return () => {
      observer?.disconnect();
      document.removeEventListener("visibilitychange", change);
    };
  }, []);

  const body = flatMascotBody(bot.mascotBody);
  const scale = FACE_BOX / 100;
  const silhouette = useMemo(() => ({
    name: body.name,
    fit: `scale(${scale})`,
    body: `<path d="${body.path}" fill="{{GRADIENT}}"/>`,
    clip: `<path d="${body.path}"/>`,
    anchor: { x: (50 + body.faceX * .5) * scale, y: (46 + body.faceY) * scale, scale: .55 },
  }), [body, scale]);
  const choreography = useMemo(
    () => ({ gesture, key: 0, path: body.path, faceX: body.faceX, faceY: body.faceY, reduced }),
    [gesture, body, reduced],
  );

  const profile = botAvatarProfile(bot);
  const photo = resolveBotAvatarOutcome({ avatarCrop: profile.avatarCrop, hasUrl: Boolean(profile.avatarUrl), imageFailed: false }) === "flatImage";
  if (photo) {
    return <span className="flex bot-morph"><BotAvatar bot={bot} size={size} trackPointer={false} /></span>;
  }

  const color = resolveMausColor(bot.color);
  const running = visible && active && !reduced;
  // the flat bodies are 80 across in their 100 box; the face sits on the
  // same anchor the ring eyes use, nudged to the body's middle
  const glyphFace = botMascotEyes(bot.mascotEyes) === "glyph"
    ? glyphFaceParts({
      state: glyphStateFor(gesture),
      color,
      centre: [50 + body.faceX * .5, 50 + body.faceY],
      diameter: 80,
      pixels: size * (80 / 100) * (FACE_BOX / (FACE_BOX + 30)),
    })
    : undefined;
  return (
    <span ref={host} className="flex" data-gesture={gesture} data-motion={reduced ? "still" : running ? "active" : "suspended"}>
      <CursorAvatar
        state={FACES[gesture]}
        size={size}
        title={bot.name ?? "bot"}
        silhouette={silhouette}
        gradient={[color, color, color]}
        eyeColor="#151515"
        showMouth={false}
        effects={false}
        glyphs={false}
        motion={0}
        lookAround={0}
        autoBlink={running}
        autoExpression={false}
        paused={!running}
        choreography={choreography}
        glyphFace={glyphFace}
      />
    </span>
  );
}
