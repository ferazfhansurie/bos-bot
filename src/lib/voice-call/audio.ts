// Browser audio for the realtime call: one 24 kHz AudioContext for both mic
// capture and playback, the way Grok Bot does it.
//
// Capture: getUserMedia {channelCount 1, echoCancellation, noiseSuppression}
// -> MediaStreamSource -> ScriptProcessor(2048, 1, 1) -> silent gain sink.
// The context is pinned at 24 kHz, so Chromium resamples the mic for us.
// Playback: one AudioBufferSource per delta, gapless via a cursor, also
// routed into a MediaStreamDestination so the UI can draw the speaker wave.

import { CONNECT_CHIME, FRAME_SIZE, HANGUP_CHIME, SAMPLE_RATE } from "./protocol";
import { renderChime } from "./chime";

const MIC_CONSTRAINTS: MediaTrackConstraints = {
  channelCount: 1,
  echoCancellation: true,
  noiseSuppression: true,
};

export interface ScheduledSpan {
  startsAt: number;
  endsAt: number;
}

export interface CallStreams {
  microphone: MediaStream | null;
  speaker: MediaStream | null;
}

/** What the engine needs from audio. Faked in tests. */
export interface CallAudio {
  /** Prompts for the mic and starts capture. Rejects with a MicrophoneError. */
  start(onFrame: (samples: Float32Array) => void): Promise<void>;
  /** Queue one delta for gapless playback; null for an empty delta. */
  schedule(samples: Float32Array): ScheduledSpan | null;
  currentTime(): number;
  isPlaying(): boolean;
  /** Barge-in: stop every scheduled source now and reset the cursor. */
  dropScheduled(): void;
  /** Called whenever the last scheduled source finishes on its own. */
  onSpeechEnded(listener: () => void): void;
  streams(): CallStreams;
  playConnectChime(): void;
  close(): void;
}

export type MicrophoneFailure = "denied" | "unavailable";

export class MicrophoneError extends Error {
  constructor(
    readonly kind: MicrophoneFailure,
    message: string,
  ) {
    super(message);
    this.name = "MicrophoneError";
  }
}

const isDeviceGone = (error: unknown): boolean => {
  const name = (error as { name?: string } | null)?.name;
  return name === "OverconstrainedError" || name === "NotFoundError" || name === "NotReadableError";
};

async function acquireMicrophone(deviceId: string | null): Promise<MediaStream> {
  const constraints = deviceId ? { ...MIC_CONSTRAINTS, deviceId: { exact: deviceId } } : MIC_CONSTRAINTS;
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: constraints });
  } catch (error) {
    // The chosen device is gone: fall back to the default one.
    if (!deviceId || !isDeviceGone(error)) throw error;
    return await navigator.mediaDevices.getUserMedia({ audio: MIC_CONSTRAINTS });
  }
}

function toMicrophoneError(error: unknown): MicrophoneError {
  const name = (error as { name?: string } | null)?.name;
  if (name === "NotAllowedError" || name === "SecurityError") {
    return new MicrophoneError("denied", "Microphone access was blocked.");
  }
  const message = error instanceof Error && error.message ? error.message : "No microphone is available.";
  return new MicrophoneError("unavailable", message);
}

export class BrowserCallAudio implements CallAudio {
  private readonly context: AudioContext;
  private readonly speakerTap: MediaStreamAudioDestinationNode;
  private readonly scheduled = new Set<AudioBufferSourceNode>();
  private readonly speechEndedListeners = new Set<() => void>();
  private cursor = 0;
  private microphone: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private sink: GainNode | null = null;
  private closed = false;

  constructor(private readonly deviceId: string | null = null) {
    // Created synchronously from the click so autoplay policy never blocks it.
    this.context = new AudioContext({ sampleRate: SAMPLE_RATE });
    this.speakerTap = this.context.createMediaStreamDestination();
  }

  async start(onFrame: (samples: Float32Array) => void): Promise<void> {
    let stream: MediaStream;
    try {
      stream = await acquireMicrophone(this.deviceId);
    } catch (error) {
      throw toMicrophoneError(error);
    }
    if (this.closed) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    this.microphone = stream;
    if (this.context.state === "suspended") await this.context.resume().catch(() => undefined);
    const source = this.context.createMediaStreamSource(stream);
    const processor = this.context.createScriptProcessor(FRAME_SIZE, 1, 1);
    processor.onaudioprocess = (event) => onFrame(event.inputBuffer.getChannelData(0));
    // A ScriptProcessor only runs while connected to the destination; a zero
    // gain keeps it running without echoing the mic back.
    const sink = this.context.createGain();
    sink.gain.value = 0;
    sink.connect(this.context.destination);
    source.connect(processor);
    processor.connect(sink);
    this.source = source;
    this.processor = processor;
    this.sink = sink;
  }

  schedule(samples: Float32Array): ScheduledSpan | null {
    if (samples.length === 0 || this.closed) return null;
    const buffer = this.context.createBuffer(1, samples.length, SAMPLE_RATE);
    buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
    const node = this.context.createBufferSource();
    node.buffer = buffer;
    node.connect(this.context.destination);
    node.connect(this.speakerTap);
    const startsAt = Math.max(this.context.currentTime, this.cursor);
    node.start(startsAt);
    this.scheduled.add(node);
    node.onended = () => {
      this.scheduled.delete(node);
      if (this.scheduled.size === 0) for (const listener of this.speechEndedListeners) listener();
    };
    this.cursor = startsAt + buffer.duration;
    return { startsAt, endsAt: this.cursor };
  }

  currentTime(): number {
    return this.context.currentTime;
  }

  isPlaying(): boolean {
    return this.scheduled.size > 0;
  }

  dropScheduled(): void {
    for (const node of this.scheduled) {
      node.onended = null;
      try {
        node.stop();
      } catch {
        // Already stopped.
      }
      node.disconnect();
    }
    this.scheduled.clear();
    this.cursor = 0;
  }

  onSpeechEnded(listener: () => void): void {
    this.speechEndedListeners.add(listener);
  }

  streams(): CallStreams {
    return { microphone: this.microphone, speaker: this.speakerTap.stream };
  }

  playConnectChime(): void {
    if (this.closed) return;
    playSamples(this.context, renderChime(CONNECT_CHIME, SAMPLE_RATE));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.dropScheduled();
    this.speechEndedListeners.clear();
    if (this.processor) this.processor.onaudioprocess = null;
    this.source?.disconnect();
    this.processor?.disconnect();
    this.sink?.disconnect();
    for (const track of this.microphone?.getTracks() ?? []) track.stop();
    void this.context.close().catch(() => undefined);
  }
}

function playSamples(context: AudioContext, samples: Float32Array): AudioBufferSourceNode {
  const buffer = context.createBuffer(1, samples.length, SAMPLE_RATE);
  buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
  const node = context.createBufferSource();
  node.buffer = buffer;
  node.connect(context.destination);
  node.start(context.currentTime);
  return node;
}

/** Hang-up chime plays in a fresh context: the call's own one is closing. */
export function playHangupChime(): void {
  try {
    const context = new AudioContext({ sampleRate: SAMPLE_RATE });
    const node = playSamples(context, renderChime(HANGUP_CHIME, SAMPLE_RATE));
    node.onended = () => void context.close().catch(() => undefined);
  } catch {
    // No audio output: the call still ends.
  }
}
