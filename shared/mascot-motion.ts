// The one motion table for bos bot 3.0: desktop, ios and android read the
// same springs, easings and mascot timings, so a mascot that hops on the mac
// hops the same way on the phone.
//
// Springs are written the way SwiftUI says them (response in seconds, damping
// fraction), since that is what the ios app already uses. Each one is also
// given as stiffness/damping at mass 1 (Compose's spring(dampingRatio,
// stiffness) and framer-style springs) and as a sampled CSS `linear()` easing
// with the time it takes to settle, for the web.
//
// shared/motion.json is generated from this file for the native apps; the
// test fails when the two drift. Regenerate with:
//   UPDATE_MOTION=1 npx vitest run shared/mascot-motion.test.ts
import { GESTURE_TIMING } from "./mascot-choreography";

export interface SpringSpec {
  /** seconds for one undamped oscillation (SwiftUI `response`) */
  response: number;
  /** 1 is critically damped; lower overshoots (SwiftUI `dampingFraction`, Compose `dampingRatio`) */
  dampingFraction: number;
}

export const SPRINGS = {
  /** taps, toggles, a dot appearing */
  snap: { response: 0.25, dampingFraction: 0.7 },
  /** popovers, menus, the composer growing */
  pop: { response: 0.3, dampingFraction: 0.75 },
  /** panels and sheets sliding in */
  glide: { response: 0.42, dampingFraction: 0.74 },
  /** a mascot arriving, celebrating, landing a hop */
  bounce: { response: 0.45, dampingFraction: 0.62 },
  /** a mascot travelling from one surface to another */
  travel: { response: 0.9, dampingFraction: 0.9 },
} as const satisfies Record<string, SpringSpec>;

/** Curves for things that ease rather than spring (fades, exits). */
export const EASINGS = {
  standard: [0.22, 1, 0.36, 1],
  overshoot: [0.34, 1.56, 0.64, 1],
  settle: [0.16, 1, 0.3, 1],
} as const;

export const DURATIONS_MS = { fast: 160, base: 220, slow: 320 } as const;

/** How a travelling mascot moves between surfaces. */
export const TRAVEL = {
  spring: "travel",
  /** the arc's peak, as a share of the straight-line distance */
  arcLift: 0.18,
  /** never lift higher than this, px */
  arcMaxPx: 120,
  /** squash on landing, then back to 1 on the bounce spring */
  landSquash: 0.86,
} as const;

const round = (value: number, places = 4) => Number(value.toFixed(places));

/** The step response of a spring from 0 to 1 at time t (seconds). */
export function springAt(spec: SpringSpec, t: number): number {
  const omega = (2 * Math.PI) / spec.response;
  const zeta = spec.dampingFraction;
  if (zeta >= 1) return 1 - Math.exp(-omega * t) * (1 + omega * t);
  const wd = omega * Math.sqrt(1 - zeta * zeta);
  return 1 - Math.exp(-zeta * omega * t) * (Math.cos(wd * t) + (zeta * omega / wd) * Math.sin(wd * t));
}

/** When the spring's envelope stays within 0.1% of rest, in ms. */
export function settleMs(spec: SpringSpec): number {
  const omega = (2 * Math.PI) / spec.response;
  const zeta = Math.min(spec.dampingFraction, 0.999);
  return Math.ceil((Math.log(1000 / Math.sqrt(1 - zeta * zeta)) / (zeta * omega)) * 1000 / 10) * 10;
}

/** A CSS `linear()` easing that traces the spring over settleMs. */
export function springCss(spec: SpringSpec, points = 40): string {
  const total = settleMs(spec) / 1000;
  const stops: string[] = [];
  for (let i = 0; i <= points; i++) {
    const value = i === points ? 1 : springAt(spec, (total * i) / points);
    stops.push(String(round(value, 3)));
  }
  return `linear(${stops.join(", ")})`;
}

function expand(spec: SpringSpec) {
  const omega = (2 * Math.PI) / spec.response;
  return {
    response: spec.response,
    dampingFraction: spec.dampingFraction,
    stiffness: round(omega * omega, 2),
    damping: round(2 * spec.dampingFraction * omega, 3),
    mass: 1,
    settleMs: settleMs(spec),
    css: springCss(spec),
  };
}

export const MOTION = {
  version: 1,
  springs: Object.fromEntries(Object.entries(SPRINGS).map(([name, spec]) => [name, expand(spec)])) as
    Record<keyof typeof SPRINGS, ReturnType<typeof expand>>,
  easings: Object.fromEntries(Object.entries(EASINGS).map(([name, curve]) => [name, {
    bezier: [...curve],
    css: `cubic-bezier(${curve.join(", ")})`,
  }])) as Record<keyof typeof EASINGS, { bezier: number[]; css: string }>,
  durationsMs: DURATIONS_MS,
  /** each mascot gesture: [how long it plays, how long before it may repeat], ms */
  gestures: Object.fromEntries(Object.entries(GESTURE_TIMING).map(([name, [play, rest]]) => [name, { playMs: play, restMs: rest }])) as
    Record<keyof typeof GESTURE_TIMING, { playMs: number; restMs: number }>,
  travel: TRAVEL,
};
