// The notch's motion and outline. Every size change runs on a spring, so a
// shape interrupted mid-move carries its speed into the next one instead of
// restarting a curve. Pure: the page drives it from requestAnimationFrame,
// and only while something is still moving.

export interface SpringConfig {
  stiffness: number;
  damping: number;
}

/** Slightly under critical: a short overshoot, no wobble. */
export const SHAPE_SPRING: SpringConfig = { stiffness: 420, damping: 34 };
/** Folding back is quicker and does not overshoot. */
export const FOLD_SPRING: SpringConfig = { stiffness: 520, damping: 46 };

const REST_DELTA = 0.02;
const REST_SPEED = 0.05;
const MAX_STEP = 1 / 240;

export class Spring {
  value: number;
  target: number;
  velocity = 0;
  config: SpringConfig;

  constructor(value: number, config: SpringConfig = SHAPE_SPRING) {
    this.value = value;
    this.target = value;
    this.config = config;
  }

  set(target: number, config?: SpringConfig) {
    this.target = target;
    if (config) this.config = config;
  }

  /** Straight to a value, no motion (reduce motion, first paint). */
  jump(value: number) {
    this.value = value;
    this.target = value;
    this.velocity = 0;
  }

  get moving(): boolean {
    return Math.abs(this.target - this.value) > REST_DELTA || Math.abs(this.velocity) > REST_SPEED;
  }

  /** Advance by `dt` seconds; returns whether it is still moving. Small
   * fixed substeps keep a stiff spring stable on a dropped frame. */
  step(dt: number): boolean {
    let left = Math.min(dt, 0.064);
    const { stiffness, damping } = this.config;
    while (left > 0) {
      const h = Math.min(left, MAX_STEP);
      const force = -stiffness * (this.value - this.target) - damping * this.velocity;
      this.velocity += force * h;
      this.value += this.velocity * h;
      left -= h;
    }
    if (!this.moving) {
      this.value = this.target;
      this.velocity = 0;
      return false;
    }
    return true;
  }
}

const r2 = (value: number) => Math.round(value * 100) / 100;

/**
 * The outline: flush with the top of the screen, flared top corners where it
 * meets the menu bar (like the camera housing's own), and continuous
 * (squircle-like) bottom corners. `cx` is the centre, `width` and `height`
 * the body below the flare, `radius` the bottom corner, `ear` the flare.
 */
export function notchPath(cx: number, width: number, height: number, radius: number, ear: number): string {
  const w = Math.max(0, width);
  const h = Math.max(0, height);
  const e = Math.max(0, Math.min(ear, h / 3, w / 4));
  // the corner's curve starts a little further out than a circle's would;
  // that run-in is what makes it read as one continuous curve
  const reach = 1.25;
  const r = Math.max(0, Math.min(radius, w / (2 * reach), (h - e) / reach));
  const x0 = cx - w / 2;
  const x1 = cx + w / 2;
  const run = r * reach;
  const pull = r * 0.36;
  const earPull = e * 0.45;
  return [
    `M${r2(x0 - e)} 0`,
    `C${r2(x0 - earPull)} 0 ${r2(x0)} ${r2(e - earPull)} ${r2(x0)} ${r2(e)}`,
    `L${r2(x0)} ${r2(h - run)}`,
    `C${r2(x0)} ${r2(h - pull)} ${r2(x0 + pull)} ${r2(h)} ${r2(x0 + run)} ${r2(h)}`,
    `L${r2(x1 - run)} ${r2(h)}`,
    `C${r2(x1 - pull)} ${r2(h)} ${r2(x1)} ${r2(h - pull)} ${r2(x1)} ${r2(h - run)}`,
    `L${r2(x1)} ${r2(e)}`,
    `C${r2(x1)} ${r2(e - earPull)} ${r2(x1 + earPull)} 0 ${r2(x1 + e)} 0`,
    "Z",
  ].join("");
}
