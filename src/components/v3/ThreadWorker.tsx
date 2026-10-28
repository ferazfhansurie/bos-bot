// 3.0: while a turn runs the bot stands at the end of the thread, where the
// person is already looking, instead of a status line up in the header. It
// is the same travelling mascot (the stage's "island" spot): it hops in from
// its row, wears the face of what it is doing, notices words sent mid-turn
// and winks when it has read them, digs in on a long job, and celebrates
// before it walks home. Every accent is the bot's own colour, so two bots
// working side by side never look alike.
//
// Motion is transform/opacity only and stops under reduced motion.
import { createContext, useContext, useEffect, useRef, useState, type CSSProperties } from "react";
import { Check, Square } from "lucide-react";
import { ActivityMascot } from "../ActivityMascot";
import { WorkingTimer } from "../WorkingIndicator";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { toolLabel } from "@/lib/live-activity";
import { faceHere, travelName, useStage } from "@/lib/v3-stage";
import { resolveMausColor, type GlyphFaceState } from "../../../shared/glyph-faces";
import type { MascotGesture } from "../../../shared/mascot-choreography";
import type { Bot, Message } from "@/state/store";
import { EmptySeat } from "./Alive";
import { pick } from "./alive-mood";
import { doneTrail, SLOW_S, type SteerRead } from "./thread-worker";
import "./alive.css";

/** Mid-turn sends and whether the bot has read them yet, for their bubbles. */
export const SteerReadContext = createContext<{ reads: Map<string, SteerRead>; name: string; color: string } | null>(null);

/** One line from a "|" separated locale set, the same one for the same seed. */
function line(key: Parameters<typeof t>[0], seed: string): string {
  return pick(t(key).split("|"), seed);
}

const DONE_FACES: GlyphFaceState[] = ["celebrate", "proud", "finished", "happy"];

type Reaction = { kind: "noticed" | "read"; id: string } | null;

export function ThreadWorker({
  bot,
  gesture,
  label,
  since,
  needsYou,
  finishing,
  steps,
  turnKey,
  newestSteer,
  lastNews,
  onStop,
}: {
  bot: Bot;
  gesture: MascotGesture;
  label: string;
  since: number | null;
  needsYou: boolean;
  finishing: boolean;
  /** the running turn's tool steps */
  steps: readonly Message[];
  /** stable per turn: seeds which line and face it picks */
  turnKey: string;
  /** the newest mid-turn send and whether it has been read */
  newestSteer?: { id: string; read: SteerRead };
  /** when anything last happened in the turn */
  lastNews: number | null;
  onStop?: () => void;
}) {
  const stage = useStage(bot.id);
  const here = faceHere(stage, "island");
  const color = resolveMausColor(bot.color);

  // noticed the moment words arrive mid-turn, then a wink and a line once read
  const [reaction, setReaction] = useState<Reaction>(null);
  const seen = useRef(new Map<string, SteerRead>());
  // whatever was already sent when the row mounted is old news
  const oldNews = useRef(newestSteer?.id);
  useEffect(() => {
    if (!newestSteer || newestSteer.id === oldNews.current) return;
    const before = seen.current.get(newestSteer.id);
    seen.current.set(newestSteer.id, newestSteer.read);
    if (before === newestSteer.read) return;
    setReaction({ kind: newestSteer.read === "read" ? "read" : "noticed", id: newestSteer.id });
    const timer = setTimeout(() => setReaction(null), newestSteer.read === "read" ? 2400 : 1400);
    return () => clearTimeout(timer);
  }, [newestSteer?.id, newestSteer?.read]);

  // a quiet clock for "still on it": coarse, not every frame
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (lastNews === null || finishing) return;
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, [lastNews, finishing]);
  const slow = !finishing && !needsYou && lastNews !== null && now - lastNews >= SLOW_S * 1000;

  // a step that just finished pops its tick once
  const trail = doneTrail(steps);
  const newestDone = trail.at(-1)?.id;
  const firstDone = useRef(newestDone);
  const fresh = newestDone !== undefined && newestDone !== firstDone.current;

  const working = !finishing && !needsYou;
  const face: GlyphFaceState | undefined = finishing
    ? (steps.length >= 10 ? "nailed-it" : pick(DONE_FACES, turnKey))
    : reaction?.kind === "read" ? pick<GlyphFaceState>(["wink", "happy"], reaction.id)
    : reaction?.kind === "noticed" ? "noticed"
    : needsYou ? "waiting"
    : slow ? "determined"
    : undefined;

  const say = finishing ? line("v3.worker.done", turnKey)
    : reaction?.kind === "read" ? line("v3.worker.gotIt", reaction.id)
    : null;

  return (
    <div
      className="v3-worker flex w-full items-start gap-3 pt-1 pb-2"
      style={{ "--c": color } as CSSProperties}
      data-testid="v3-thread-worker"
    >
      <div className="relative flex size-12 shrink-0 items-center justify-center" style={travelName(stage, "island")} data-testid="v3-island" data-v3-face={here ? bot.id : undefined}>
        {here ? (
          <>
            <span aria-hidden className={cn("v3-worker-halo", slow && "v3-worker-halo-slow")} />
            {working && <span aria-hidden className={cn("v3-worker-orbit", slow && "v3-worker-orbit-slow")}><i /></span>}
            <span
              key={finishing ? "done" : reaction ? `${reaction.kind}:${reaction.id}` : "work"}
              className={cn("relative flex", finishing ? "v3-hop" : reaction?.kind === "read" ? "v3-worker-nod" : reaction?.kind === "noticed" ? "v3-worker-perk" : "v3-worker-bob")}
            >
              <ActivityMascot bot={bot} gesture={gesture} size={40} face={face} />
            </span>
            {reaction?.kind === "noticed" && <span aria-hidden className="v3-worker-bang">!</span>}
            {finishing && (
              <span aria-hidden className="v3-worker-confetti">
                {Array.from({ length: 8 }, (_, i) => <i key={i} style={{ "--a": `${i * 45 + 12}deg` } as CSSProperties} />)}
              </span>
            )}
          </>
        ) : (
          // it stepped out (a tab it works in, the button it points at)
          <EmptySeat bot={bot} size={28} />
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-1 pt-1.5">
        <div className="flex min-w-0 items-center gap-2" role="status" aria-live="polite">
          {needsYou ? (
            <span className="truncate text-[13.5px] font-medium text-accent">{t("v3.island.needsYou")}</span>
          ) : say ? (
            <span key={say} className="v3-worker-say truncate">{say}</span>
          ) : (
            <span key={label} className="v3-worker-line status-swap truncate text-[13.5px]">{label}</span>
          )}
          {!finishing && (
            <span className="ms-auto flex shrink-0 items-center gap-1.5 ps-2 text-[11.5px] text-ink-secondary/70">
              {since !== null && <WorkingTimer since={since} className="whitespace-nowrap" />}
              {steps.length > 0 && (
                <span key={steps.length} className="v3-worker-count" data-testid="v3-worker-steps">
                  {steps.length === 1 ? t("v3.worker.step") : t("v3.worker.steps", { count: steps.length })}
                </span>
              )}
            </span>
          )}
        </div>

        {!finishing && trail.length > 0 && (
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-[12px] text-ink-secondary/55" data-testid="v3-worker-trail">
            {trail.map((step) => (
              <span key={step.id} className="flex min-w-0 max-w-[16rem] items-center gap-1">
                <Check size={11} strokeWidth={3} className={cn("v3-worker-tick shrink-0", fresh && step.id === newestDone && "v3-worker-tick-pop", step.tool?.ok === false && "opacity-50")} />
                <span className="truncate">{toolLabel(step)}</span>
              </span>
            ))}
          </div>
        )}

        {slow && (
          <div className="v3-worker-slow mt-0.5 flex w-fit max-w-full items-center gap-2 rounded-full py-1 ps-3 pe-1 text-[12.5px] text-ink-secondary" data-testid="v3-worker-slow">
            <span className="truncate">{line("v3.worker.slow", turnKey)}</span>
            {onStop && (
              <button
                type="button"
                onClick={onStop}
                className="flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[12px] font-medium text-ink hover:bg-raised"
                aria-label={t("chat.stopTurn")}
              >
                <Square size={9} className="fill-current" />
                {t("chat.stop")}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** The line under a send made while the bot works: waiting for it, then read. */
export function SteerReadLabel({ id }: { id: string }) {
  const steer = useContext(SteerReadContext);
  const read = steer?.reads.get(id);
  if (!steer || !read) return null;
  return read === "read" ? (
    <div key="read" className="v3-steer-read mt-1 flex items-center gap-1 text-[11px] chat-text-tertiary" style={{ "--c": steer.color } as CSSProperties} data-testid="v3-steer-read">
      <Check size={11} strokeWidth={3} className="v3-worker-tick v3-worker-tick-pop" />
      {t("v3.steer.read", { name: steer.name })}
    </div>
  ) : (
    <div key="waiting" className="mt-1 flex items-center gap-1.5 text-[11px] chat-text-tertiary" title={t("v3.steer.waitingHint", { name: steer.name })} style={{ "--c": steer.color } as CSSProperties} data-testid="v3-steer-waiting">
      <span aria-hidden className="v3-steer-spin" />
      {t("v3.steer.waiting", { name: steer.name })}
    </div>
  );
}
