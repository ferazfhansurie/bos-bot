// Browser voice messages: record with MediaRecorder where the desktop app's
// native dictation is not available (any browser, iPhone Safari included).
// iOS Safari records AAC in audio/mp4; Chrome and Firefox record Opus in
// webm/ogg. The server accepts all three as audio attachments.

/** A voice message is a message, not a meeting. The relay caps higher. */
export const VOICE_MAX_MS = 30 * 60 * 1000;
/** Speech needs little: 48 kbps keeps 30 minutes near 11 MB. */
const VOICE_BITS_PER_SECOND = 48_000;

export function voiceRecordingSupported(scope: { MediaRecorder?: unknown; navigator?: Navigator } = globalThis as never): boolean {
  return typeof scope.MediaRecorder === "function" && typeof scope.navigator?.mediaDevices?.getUserMedia === "function";
}

/** WebKit on iPhone, iPad and the Mac (not Chrome, which says "Safari" too). */
export function isAppleWebKit(userAgent: string): boolean {
  if (/iPhone|iPad|iPod/i.test(userAgent)) return true;
  return /Safari\//.test(userAgent) && !/Chrome\/|Chromium\/|CriOS\/|Edg\/|Android/i.test(userAgent);
}

/** The container to ask for, in order of preference. Safari can claim
 * webm support it plays badly; mp4/AAC is its native recording. */
export function pickRecordingMime(isTypeSupported: (mime: string) => boolean, userAgent: string): string {
  const apple = ["audio/mp4;codecs=mp4a.40.2", "audio/mp4", "audio/aac"];
  const opus = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/ogg"];
  const order = isAppleWebKit(userAgent) ? [...apple, ...opus] : [...opus, ...apple];
  for (const mime of order) {
    try {
      if (isTypeSupported(mime)) return mime;
    } catch {
      /* an old engine that throws on unknown types */
    }
  }
  return "";
}

/** The upload's mime (no codec parameter) and file extension. */
export function recordingFileType(mime: string): { mime: string; extension: string } {
  const base = mime.split(";", 1)[0]!.trim().toLowerCase();
  if (base === "audio/mp4" || base === "audio/aac" || base === "audio/x-m4a" || base === "video/mp4") return { mime: "audio/mp4", extension: "m4a" };
  if (base === "audio/ogg") return { mime: "audio/ogg", extension: "ogg" };
  return { mime: "audio/webm", extension: "webm" };
}

export type MicProblem = "denied" | "missing" | "insecure" | "busy" | "other";

export function micProblem(error: unknown, secure = globalThis.isSecureContext !== false): MicProblem {
  if (!secure) return "insecure";
  const name = typeof error === "object" && error && "name" in error ? String((error as { name: unknown }).name) : "";
  if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") return "denied";
  if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") return "missing";
  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") return "busy";
  return "other";
}

/** Where to turn the microphone back on, for the browser in use. */
export function micSettingsPlace(userAgent: string): "ios" | "safari" | "chrome" | "other" {
  if (/iPhone|iPad|iPod/i.test(userAgent)) return "ios";
  if (isAppleWebKit(userAgent)) return "safari";
  if (/Chrome\/|Chromium\/|Edg\//.test(userAgent)) return "chrome";
  return "other";
}

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export interface FinishedRecording {
  blob: Blob;
  mime: string;
  extension: string;
  durationMs: number;
}

/** One live recording. Chunks are collected every second so a recording
 * that is stopped by the page going away still has most of its audio. */
export class VoiceRecording {
  readonly stream: MediaStream;
  readonly startedAt: number;
  private readonly recorder: MediaRecorder;
  private readonly chunks: Blob[] = [];
  private readonly mime: string;
  private stopped: Promise<void>;
  private limitTimer: ReturnType<typeof setTimeout> | undefined;

  private constructor(stream: MediaStream, recorder: MediaRecorder, mime: string, onLimit: () => void) {
    this.stream = stream;
    this.recorder = recorder;
    this.mime = mime;
    this.startedAt = Date.now();
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data && event.data.size > 0) this.chunks.push(event.data);
    });
    this.stopped = new Promise((done) => {
      recorder.addEventListener("stop", () => done(), { once: true });
      recorder.addEventListener("error", () => done(), { once: true });
    });
    this.limitTimer = setTimeout(onLimit, VOICE_MAX_MS);
  }

  /** Asks for the microphone (the browser's permission prompt) and starts. */
  static async start(onLimit: () => void): Promise<VoiceRecording> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    try {
      const chosen = pickRecordingMime((mime) => MediaRecorder.isTypeSupported(mime), navigator.userAgent);
      const options: MediaRecorderOptions = { audioBitsPerSecond: VOICE_BITS_PER_SECOND };
      if (chosen) options.mimeType = chosen;
      let recorder: MediaRecorder;
      try {
        recorder = new MediaRecorder(stream, options);
      } catch {
        recorder = new MediaRecorder(stream);
      }
      const recording = new VoiceRecording(stream, recorder, recorder.mimeType || chosen, onLimit);
      recorder.start(1000);
      return recording;
    } catch (error) {
      stream.getTracks().forEach((track) => track.stop());
      throw error;
    }
  }

  private release(): void {
    clearTimeout(this.limitTimer);
    this.stream.getTracks().forEach((track) => track.stop());
  }

  async stop(): Promise<FinishedRecording> {
    const durationMs = Date.now() - this.startedAt;
    if (this.recorder.state !== "inactive") {
      try {
        this.recorder.requestData();
      } catch {
        /* Safari may refuse requestData right before stop */
      }
      this.recorder.stop();
    }
    await this.stopped;
    this.release();
    const type = recordingFileType(this.mime || this.chunks[0]?.type || "");
    return { blob: new Blob(this.chunks, { type: type.mime }), mime: type.mime, extension: type.extension, durationMs };
  }

  cancel(): void {
    try {
      if (this.recorder.state !== "inactive") this.recorder.stop();
    } catch {
      /* already stopped */
    }
    this.chunks.length = 0;
    this.release();
  }
}
