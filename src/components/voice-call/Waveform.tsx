import { useEffect, useRef } from "react";

import {
  ANALYSER_SMOOTHING,
  AdaptiveFloor,
  FFT_SIZE,
  bandRms,
  barCount,
  fixedFloorLevel,
  simulatedLevel,
  smooth,
  spectrumBars,
} from "@/lib/voice-call/waveform";

export interface WaveformProps {
  stream: MediaStream | null;
  barColor: string;
  barWidth?: number;
  barGap?: number;
  /** Minimum bar height; 0 hides bars at silence. */
  barHeight?: number;
  height?: number;
  sensitivity?: number;
  noiseFloor?: "fixed" | "adaptive";
  /** What to draw without a stream. */
  fallback?: "static" | "simulated";
}

/** Spectrum bars drawn from a MediaStream, the call's mic or speaker. */
export function Waveform({
  stream,
  barColor,
  barWidth = 3,
  barGap = 4,
  barHeight = 0,
  height = 28,
  sensitivity = 0.9,
  noiseFloor = "fixed",
  fallback = "static",
}: WaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx2d = canvas.getContext("2d");
    if (!ctx2d) return;
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

    let audio: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;
    let source: MediaStreamAudioSourceNode | null = null;
    if (stream && stream.getAudioTracks().length > 0 && !reducedMotion) {
      try {
        audio = new AudioContext();
        void audio.resume().catch(() => undefined);
        analyser = audio.createAnalyser();
        analyser.fftSize = FFT_SIZE;
        analyser.smoothingTimeConstant = ANALYSER_SMOOTHING;
        source = audio.createMediaStreamSource(stream);
        source.connect(analyser);
      } catch {
        analyser = null;
      }
    }
    const data = new Uint8Array(FFT_SIZE / 2);
    const floor = new AdaptiveFloor();
    let levels: number[] = [];
    let frame = 0;

    const draw = (now: number) => {
      const dpr = window.devicePixelRatio || 1;
      const width = canvas.clientWidth;
      if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
      }
      ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx2d.clearRect(0, 0, width, height);
      const count = barCount(width, barWidth, barGap);
      if (levels.length !== count) levels = Array.from({ length: count }, () => 0);

      let targets: number[];
      if (analyser && audio) {
        analyser.getByteFrequencyData(data);
        const raw = spectrumBars(data, audio.sampleRate, count);
        if (noiseFloor === "adaptive") {
          floor.update(bandRms(data, audio.sampleRate), now);
          targets = raw.map((r) => floor.level(r, sensitivity));
        } else {
          targets = raw.map((r) => fixedFloorLevel(r, sensitivity));
        }
      } else if (fallback === "simulated" && !reducedMotion) {
        targets = levels.map((_, bar) => simulatedLevel(bar, now) * 0.35);
      } else {
        targets = levels.map(() => 0);
      }
      levels = levels.map((previous, i) => smooth(previous, targets[i] ?? 0));

      const total = count * barWidth + Math.max(0, count - 1) * barGap;
      const offset = (width - total) / 2;
      ctx2d.fillStyle = barColor;
      for (let i = 0; i < count; i++) {
        const h = Math.max(barHeight, levels[i] * height);
        if (h <= 0) continue;
        const x = offset + i * (barWidth + barGap);
        const y = (height - h) / 2;
        ctx2d.beginPath();
        ctx2d.roundRect(x, y, barWidth, h, Math.min(barWidth, h) / 2);
        ctx2d.fill();
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(frame);
      source?.disconnect();
      void audio?.close().catch(() => undefined);
    };
  }, [stream, barColor, barWidth, barGap, barHeight, height, sensitivity, noiseFloor, fallback]);

  return <canvas ref={canvasRef} className="block w-full" style={{ height }} aria-hidden="true" />;
}
