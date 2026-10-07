// Call chimes, synthesized: sine notes with a 6 ms attack, (1 - t/dur)^2
// decay and gain 0.16. Connect rises, hang-up falls. No audio assets.

import { CHIME_ATTACK_S, CHIME_GAIN } from "./protocol";

export interface ChimeNote {
  hz: number;
  ms: number;
}

export function renderChime(notes: readonly ChimeNote[], sampleRate: number): Float32Array {
  const lengths = notes.map((n) => Math.round((n.ms / 1000) * sampleRate));
  const out = new Float32Array(lengths.reduce((a, b) => a + b, 0));
  let offset = 0;
  notes.forEach((note, index) => {
    const length = lengths[index];
    const duration = note.ms / 1000;
    for (let i = 0; i < length; i++) {
      const t = i / sampleRate;
      const attack = Math.min(1, t / CHIME_ATTACK_S);
      const decay = (1 - t / duration) ** 2;
      out[offset + i] = Math.sin(2 * Math.PI * note.hz * t) * CHIME_GAIN * attack * decay;
    }
    offset += length;
  });
  return out;
}
