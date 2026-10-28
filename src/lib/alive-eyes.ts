// 3.0 alive eyes: the pure rules behind where a face looks and when it
// blinks. CursorAvatar and the v3 surfaces read these; nothing here touches
// the DOM, so the rules are tested on their own.

/** How far the pointer can be and still be watched, in px. */
export const GAZE_RADIUS = 300;

/** Where the eyes aim (x, y in -1..1) for a pointer at `pointer` and a face
 * centred at `centre`; null once the pointer is out of reach, so the eyes
 * drift back to the middle. */
export function pointerGaze(
  pointer: { x: number; y: number },
  centre: { x: number; y: number },
  radius = GAZE_RADIUS,
): { x: number; y: number } | null {
  const dx = pointer.x - centre.x;
  const dy = pointer.y - centre.y;
  if (Math.hypot(dx, dy) > radius) return null;
  const clamp = (n: number) => Math.max(-1, Math.min(1, n));
  return { x: clamp(dx / (radius * 0.6)), y: clamp(dy / (radius * 0.6)) };
}

/** Looking up at you: a hovered seat. */
export const LOOK_UP = { x: 0, y: -0.85 } as const;

/** The wait before the next blink, and whether it is a double. Random
 * inside the state's cadence, never a fixed loop; while the person types
 * the bot pays attention and blinks half as often. */
export function nextBlink(
  cadence: readonly [number, number],
  opts: { slow?: boolean; rand?: () => number } = {},
): { delayMs: number; double: boolean } {
  const rand = opts.rand ?? Math.random;
  const [lo, hi] = cadence;
  const delay = lo + rand() * (hi - lo);
  return { delayMs: Math.round(opts.slow ? delay * 2 : delay), double: rand() < DOUBLE_BLINK };
}

/** About one blink in seven comes as a pair. */
export const DOUBLE_BLINK = 1 / 7;
/** The gap between the two halves of a double blink. */
export const DOUBLE_GAP_MS = 380;

/** A resting face in its seat: a blink every 6–14s. */
export const REST_BLINK = [6000, 14000] as const;
