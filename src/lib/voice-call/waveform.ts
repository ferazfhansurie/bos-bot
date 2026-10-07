// Level math for the call waveform, ported from Grok Bot's waveform
// component. Analyser: fftSize 256, smoothing 0.8, byte frequency data.

export const FFT_SIZE = 256;
export const ANALYSER_SMOOTHING = 0.8;
const BAND_LOW_HZ = 280;
const BAND_HIGH_HZ = 6000;
const BARS_FROM_HZ = 1000;
const FIXED_FLOOR = 0.24;
const FIXED_GAIN = 2.2;
const ADAPTIVE_START = 0.45;
const ADAPTIVE_HOLD_MS = 300;
const ADAPTIVE_RISE_PER_S = 0.05;
const ADAPTIVE_MARGIN = 0.03;
const ADAPTIVE_GAIN = 3;
const ATTACK = 0.32;
const RELEASE = 0.12;

export function barCount(width: number, barWidth: number, gap: number): number {
  return Math.max(0, Math.floor((width + gap) / (barWidth + gap)));
}

/** Inclusive bin range for a frequency band. */
export function binRange(sampleRate: number, fftSize: number, lowHz: number, highHz: number): [number, number] {
  const hzPerBin = sampleRate / fftSize;
  const bins = fftSize / 2;
  const lo = Math.max(0, Math.min(bins - 1, Math.floor(lowHz / hzPerBin)));
  const hi = Math.max(lo, Math.min(bins - 1, Math.ceil(highHz / hzPerBin)));
  return [lo, hi];
}

/** Raw per-bar levels (0..1): bars split the 1-6 kHz bins evenly. */
export function spectrumBars(data: Uint8Array, sampleRate: number, count: number): number[] {
  if (count <= 0) return [];
  const [lo, hi] = binRange(sampleRate, FFT_SIZE, BARS_FROM_HZ, BAND_HIGH_HZ);
  const span = hi - lo + 1;
  const out: number[] = [];
  for (let bar = 0; bar < count; bar++) {
    const from = lo + Math.floor((bar * span) / count);
    const to = Math.max(from + 1, lo + Math.floor(((bar + 1) * span) / count));
    let sum = 0;
    for (let i = from; i < to; i++) sum += data[i] ?? 0;
    out.push(sum / (to - from) / 255);
  }
  return out;
}

/** RMS over the 280 Hz - 6 kHz band, 0..1. */
export function bandRms(data: Uint8Array, sampleRate: number): number {
  const [lo, hi] = binRange(sampleRate, FFT_SIZE, BAND_LOW_HZ, BAND_HIGH_HZ);
  let sum = 0;
  for (let i = lo; i <= hi; i++) {
    const v = (data[i] ?? 0) / 255;
    sum += v * v;
  }
  return Math.sqrt(sum / (hi - lo + 1));
}

export function fixedFloorLevel(raw: number, sensitivity: number): number {
  return Math.min(1, Math.max(0, raw - FIXED_FLOOR) * FIXED_GAIN * sensitivity);
}

/** Tracks the room's noise so a quiet mic shows flat bars, not hiss. */
export class AdaptiveFloor {
  private floor = ADAPTIVE_START;
  private startedAt: number | null = null;
  private lastAt: number | null = null;

  update(rms: number, nowMs: number): number {
    if (this.startedAt === null) {
      this.startedAt = nowMs;
      this.floor = Math.min(rms, ADAPTIVE_START);
    }
    const dt = this.lastAt === null ? 0 : Math.max(0, nowMs - this.lastAt) / 1000;
    this.lastAt = nowMs;
    if (nowMs - this.startedAt < ADAPTIVE_HOLD_MS) {
      this.floor = Math.min(this.floor, rms, ADAPTIVE_START);
      return this.floor;
    }
    this.floor = rms < this.floor ? rms : Math.min(rms, ADAPTIVE_START, this.floor + ADAPTIVE_RISE_PER_S * dt);
    return this.floor;
  }

  level(raw: number, sensitivity: number): number {
    return Math.min(1, Math.max(0, raw - this.floor - ADAPTIVE_MARGIN) * ADAPTIVE_GAIN * sensitivity);
  }
}

/** Fast attack, slow release. */
export function smooth(previous: number, target: number): number {
  return previous + (target - previous) * (target > previous ? ATTACK : RELEASE);
}

/** Fallback motion when there is no stream yet. */
export function simulatedLevel(bar: number, timeMs: number): number {
  const a = Math.sin(timeMs / 260 + bar * 0.9) * 0.5 + 0.5;
  return 0.4 + a * 0.5;
}
