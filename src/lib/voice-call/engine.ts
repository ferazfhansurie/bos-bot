// The realtime call engine: one live call to one bot.
//
// Port of Grok Bot desktop's call ("Sand", plans/grok-voice/protocol.md):
// phase machine, model invite, response gate, barge-in truncation, the four
// tools, end_the_call's goodbye wait, mute, mid-call settings and reconnect.
// Socket, audio, minting, chat access and timers are injected, so the whole
// thing runs under vitest with fakes.

import type {
  VoiceCallEndRequest,
  VoiceCallEvent,
  VoiceJob,
  VoiceJobStatus,
  VoiceToolName,
  VoiceTranscriptLine,
} from "../../../shared/voice-call";
import type { CallAudio, CallStreams } from "./audio";
import { MicrophoneError } from "./audio";
import { flushJournal, type VoiceJournal, type VoiceServer } from "./journal";
import { pcm16Base64ToFloat32, floatToPcm16Base64 } from "./pcm";
import {
  appendFrame,
  BACK_ON_LINE_TURN,
  CLOSE_NORMAL,
  CLOSE_POLICY,
  CLOSE_SUPERSEDED,
  DIAL_TIMEOUT_MS,
  functionOutputFrame,
  GOODBYE_MAX_MS,
  GREETING_GRACE_MS,
  historyFrames,
  isV3Plan,
  MIC_PROMPT_TIMEOUT_MS,
  parseServerEvent,
  parseToolArguments,
  passesNoiseGate,
  readBackSay,
  readTheLine,
  realtimeProtocols,
  realtimeUrl,
  reconnectDelayMs,
  responseCreateFrame,
  sessionUpdateFrame,
  TOOL_TIMEOUT_MS,
  TOOL_TIMEOUT_TEXT,
  truncateFrame,
  truncationsFor,
  UNCLEAR_SAY,
  validateTaskRequest,
  workLandedFrame,
  type AudioSpan,
  type ServerEvent,
  type SettledTurn,
  type VoiceCallCredential,
  type VoiceCallOptions,
  type VoiceCallTicket,
  type VoiceSettings,
} from "./protocol";

export type CallPhase = "idle" | "connecting" | "live" | "reconnecting" | "ending" | "failed";
export type CallActivity = "listening" | "thinking" | "streaming" | "idle";

export interface TranscriptTurn {
  id: string;
  speaker: "user" | "assistant";
  text: string;
  settled: boolean;
}

export interface CallFailure {
  code: string;
  title: string;
  detail: string;
}

export interface VoiceCallSnapshot {
  botId: string;
  phase: CallPhase;
  activity: CallActivity;
  muted: boolean;
  settings: VoiceSettings | null;
  options: VoiceCallOptions | null;
  transcript: TranscriptTurn[];
  failure: CallFailure | null;
  fault: string | null;
  startedAtMs: number | null;
  streams: CallStreams;
  /** Jobs handed to the bot with send_task that have not reported back. */
  pendingTasks: number;
}

/** The subset of WebSocket the engine uses. */
export interface CallSocket {
  readonly readyState: number;
  binaryType: string;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface RecalledMessage {
  who: "you" | "them";
  text: string;
}

/** The bot's written chat, as the call sees it. */
export interface CallHost {
  /** Post the job into the bot's chat; `onFailed` runs if it never got there. */
  sendTask(request: string, onFailed: () => void): void;
  /** The written chat, oldest first. */
  recall(): RecalledMessage[];
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface VoiceCallDeps {
  botId: string;
  mint(): Promise<VoiceCallTicket>;
  openSocket(url: string, protocols: string[]): CallSocket;
  createAudio(): CallAudio;
  host: CallHost;
  loadSettings(options: VoiceCallOptions): VoiceSettings;
  saveSettings(settings: VoiceSettings): void;
  playHangupChime?(): void;
  timers?: Timers;
  now?(): number;
  /** Fired once, when the call is over (hung up, ended or failed). */
  onFinished?(snapshot: VoiceCallSnapshot): void;
  /** One id for the whole call, reconnects included. */
  callId?: string;
  /** v3 routes (jobs, tools, events). Without it the call stays on the v2 path. */
  server?: VoiceServer;
  /** v3 on-device journal for confirmed jobs. */
  journal?: VoiceJournal;
  /** Makes a job id; stable per job, unique across calls. */
  newJobId?(): string;
}

/** A resumed call may reuse a pre-minted secret younger than this. */
export const SPARE_MAX_AGE_MS = 240_000;
/** v3 resume: give up after this many dials or this long, whichever is first. */
export const RESUME_MAX_ATTEMPTS = 5;
export const RESUME_MAX_MS = 20_000;

interface JobState {
  job: VoiceJob;
  status: VoiceJobStatus;
  threadId?: string;
  botId?: string;
}

/** Tool names the client answers itself; every other plan tool goes to the server. */
const CLIENT_TOOLS = new Set(["send_task", "confirm_job", "recall_text_messages", "stay_silent", "end_the_call"]);

/** A mint error carrying the HTTP status (409 = no xAI key, 502 = refused). */
export interface MintFailure {
  status?: number;
  message?: string;
}

const OPEN = 1;

export const STAY_SILENT_ERROR =
  "They just spoke to you and have heard nothing back. Answer out loud, and tell them what happens now. Do not stay_silent.";

const SEND_FAILED_TURN =
  "The job did not reach the chat, so nothing is under way. Tell them in one short line and offer to try again.";

const TASK_RECEIPT = {
  status: "sent",
  note: "The job is under way in the written chat. Its outcome lands later as a work_landed entry; do not chase it.",
};

type OwedTurn = { kind: "greeting" | "turn"; instructions: string | null };

const realTimers: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function mintFailureToCallFailure(error: unknown): CallFailure {
  const failure = (error ?? {}) as MintFailure;
  const detail = typeof failure.message === "string" && failure.message ? failure.message : "";
  if (failure.status === 409) {
    return { code: "mint", title: "Voice calls need an xAI key", detail: detail || "Add an xAI API key in Settings, then call again." };
  }
  if (failure.status === 502) {
    return { code: "mint", title: "xAI refused the call", detail: detail || "xAI would not open a voice session. Try again shortly." };
  }
  if (failure.status === undefined) {
    return {
      code: "mint",
      title: "No connection",
      detail: "BOS couldn't reach the server to start the call. Check your connection and call again.",
    };
  }
  return { code: "mint", title: "Couldn't start the call", detail: detail || "The voice call could not be set up." };
}

export class VoiceCallEngine {
  private readonly timers: Timers;
  private readonly now: () => number;
  private readonly listeners = new Set<() => void>();
  private snapshotCache: VoiceCallSnapshot | null = null;

  // call
  private phase: CallPhase = "idle";
  private failure: CallFailure | null = null;
  private fault: string | null = null;
  private startedAtMs: number | null = null;
  private muted = false;
  private finished = false;
  private wentLive = false;
  private ticket: VoiceCallTicket | null = null;
  private settings: VoiceSettings | null = null;
  private audio: CallAudio | null = null;
  private micGranted = false;
  private micTimer: unknown = null;
  private conversationId: string | null = null;

  // connection
  private socket: CallSocket | null = null;
  private connectionIsReconnect = false;
  private socketOpen = false;
  private invited = false;
  private sessionReady = false;
  private dialTimer: unknown = null;
  private reconnectTimer: unknown = null;
  private reconnectAttempt = 0;

  // responses
  private responding = false;
  private requested = false;
  private talkedOver = false;
  private spokeThisResponse = false;
  private callerSpeaking = false;
  private callerSpokeLast = false;
  private owed: OwedTurn | null = null;
  private greetingTimer: unknown = null;
  private cutsOwed: Array<{ itemId: string; contentIndex: number; audioEndMs: number }> = [];
  private readonly spans = new Map<string, AudioSpan>();

  // transcript + work
  private turns: TranscriptTurn[] = [];
  private readonly closedTurns = new Set<string>();
  private pendingTasks = 0;
  private landedQueue: Array<{ eventId: string; text: string; at: number }> = [];
  private landedSeq = 0;

  // v3
  private readonly callId: string;
  private spare: { ticket: VoiceCallTicket; at: number } | null = null;
  private spareTimer: unknown = null;
  private spareRefreshing = false;
  private resumeTimer: unknown = null;
  private dropAt: number | null = null;
  private drops = 0;
  private resumes = 0;
  private startRequestedAt: number | null = null;
  private endedAtMs: number | null = null;
  private firstAudioMs: number | undefined;
  private jobSeq = 0;
  private readonly pendingJobs = new Map<string, JobState>();
  private readonly jobStates = new Map<string, JobState>();
  private readonly turnAt = new Map<string, number>();

  // end_the_call
  private goodbye: { resolve: () => void; timer: unknown } | null = null;

  constructor(private readonly deps: VoiceCallDeps) {
    this.timers = deps.timers ?? realTimers;
    this.now = deps.now ?? (() => Date.now());
    this.callId = deps.callId ?? "call";
  }

  /** The v3 flow: only when the server's plan says so and the routes are wired. */
  private get v3(): boolean {
    return Boolean(this.deps.server && this.deps.journal && isV3Plan(this.ticket?.plan));
  }

  // ── public API ─────────────────────────────────────────────────────────

  get botId(): string {
    return this.deps.botId;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): VoiceCallSnapshot => {
    if (!this.snapshotCache) {
      this.snapshotCache = {
        botId: this.deps.botId,
        phase: this.phase,
        activity: this.activity(),
        muted: this.muted,
        settings: this.settings,
        options: this.ticket?.options ?? null,
        transcript: this.turns.filter((t) => t.text.trim().length > 0).map((t) => ({ ...t })),
        failure: this.failure,
        fault: this.fault,
        startedAtMs: this.startedAtMs,
        streams: this.audio?.streams() ?? { microphone: null, speaker: null },
        pendingTasks: this.v3 ? this.unsentJobs() : this.pendingTasks,
      };
    }
    return this.snapshotCache;
  };

  /** Dial: mic prompt and mint run in parallel, then the socket opens. */
  start(): void {
    if (this.phase !== "idle" || this.finished) return;
    this.startRequestedAt = this.now();
    this.setPhase("connecting");
    let audio: CallAudio;
    try {
      audio = this.deps.createAudio();
    } catch (error) {
      this.fail({ code: "microphone", title: "Audio is unavailable", detail: errorMessage(error) });
      return;
    }
    this.audio = audio;
    audio.onSpeechEnded(() => this.speechEnded());

    this.micTimer = this.timers.setTimeout(() => {
      if (this.micGranted || this.finished) return;
      this.fail({
        code: "microphone_prompt_unanswered",
        title: "Microphone prompt unanswered",
        detail: "BOS waited 30 seconds for microphone access. Call again and allow it.",
      });
    }, MIC_PROMPT_TIMEOUT_MS);

    audio.start((samples) => this.sendFrame(samples)).then(
      () => {
        this.timers.clearTimeout(this.micTimer);
        if (this.finished) return;
        this.micGranted = true;
        this.emit();
        this.maybeInvite();
        this.maybeGoLive();
      },
      (error: unknown) => {
        this.timers.clearTimeout(this.micTimer);
        if (this.finished) return;
        const denied = error instanceof MicrophoneError && error.kind === "denied";
        this.fail({
          code: denied ? "microphone_denied" : "microphone_unavailable",
          title: denied ? "Microphone blocked" : "Microphone unavailable",
          detail: denied
            ? "Allow microphone access for BOS in System Settings > Privacy & Security > Microphone, then call again."
            : errorMessage(error),
        });
      },
    );

    this.deps.mint().then(
      (ticket) => {
        if (this.finished) return;
        this.ticket = ticket;
        this.settings = this.deps.loadSettings(ticket.options);
        this.emit();
        this.dial(ticket.credential, false);
      },
      (error: unknown) => {
        if (this.finished) return;
        this.fail(mintFailureToCallFailure(error));
      },
    );
  }

  /** The caller pressed hang up. */
  hangUp(): void {
    if (this.finished) return;
    this.finish("idle");
  }

  setMuted(muted: boolean): void {
    if (this.muted === muted) return;
    this.muted = muted;
    this.emit();
  }

  /** Voice / speed / language mid-call: re-send the full session.update. */
  updateSettings(patch: Partial<VoiceSettings>): void {
    if (!this.settings) return;
    const next = { ...this.settings, ...patch };
    if (next.voice === this.settings.voice && next.speed === this.settings.speed && next.language === this.settings.language) {
      return;
    }
    this.settings = next;
    this.deps.saveSettings(next);
    if (this.invited && this.socketWritable()) this.sendSessionUpdate();
    this.emit();
  }

  /** The bot answered a job sent from this call: let it ride into the call. */
  workLanded(text: string): void {
    if (this.finished) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    if (this.pendingTasks > 0) this.pendingTasks -= 1;
    this.landedSeq += 1;
    const item = { eventId: `work-landed-${this.now()}-${this.landedSeq}`, text: trimmed, at: this.now() };
    if (this.phase === "live" && this.socketWritable()) this.send(workLandedFrame(item.eventId, item.text, item.at));
    else this.landedQueue.push(item);
    this.emit();
  }

  /** Dismiss the failure card. */
  dismiss(): void {
    if (this.phase === "failed") {
      this.phase = "idle";
      this.emit();
    }
  }

  // ── connection ─────────────────────────────────────────────────────────

  private dial(credential: VoiceCallCredential, reconnect: boolean): void {
    let socket: CallSocket;
    try {
      socket = this.deps.openSocket(
        realtimeUrl(credential, reconnect ? this.conversationId : null),
        realtimeProtocols(credential),
      );
    } catch (error) {
      if (reconnect) this.scheduleReconnect();
      else this.fail({ code: "line_error", title: "Couldn't reach xAI", detail: errorMessage(error) });
      return;
    }
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    this.connectionIsReconnect = reconnect;
    this.socketOpen = false;
    this.invited = false;
    this.sessionReady = false;

    socket.onopen = () => {
      if (socket !== this.socket) return;
      this.socketOpen = true;
      if (!reconnect && this.v3) this.postEvent({ kind: "start" });
      this.maybeInvite();
    };
    socket.onmessage = (event) => {
      if (socket !== this.socket) return;
      this.route(parseServerEvent(event.data));
    };
    socket.onclose = (event) => {
      if (socket !== this.socket) return;
      this.handleClose(event.code, event.reason);
    };
    socket.onerror = () => undefined;

    if (reconnect) {
      this.dialTimer = this.timers.setTimeout(() => {
        if (socket !== this.socket || this.phase !== "reconnecting") return;
        this.dropSocket();
        this.scheduleReconnect();
      }, DIAL_TIMEOUT_MS);
    }
  }

  private maybeInvite(): void {
    if (this.invited || !this.socketOpen || !this.micGranted || !this.ticket || !this.settings) return;
    this.invited = true;
    this.sendSessionUpdate();
    // v3 resumes the same xAI conversation; only a v2 server needs a replay.
    if (this.connectionIsReconnect && !this.v3) {
      for (const frame of historyFrames(this.settledTurns())) this.send(frame);
    }
  }

  private sendSessionUpdate(): void {
    if (!this.ticket || !this.settings) return;
    this.send(sessionUpdateFrame(this.ticket.plan, this.settings, this.connectionIsReconnect));
  }

  private maybeGoLive(): void {
    if (!this.sessionReady || !this.micGranted || this.finished) return;
    if (this.phase !== "connecting" && this.phase !== "reconnecting") return;
    const wasReconnect = this.phase === "reconnecting";
    this.timers.clearTimeout(this.dialTimer);
    this.dialTimer = null;
    this.reconnectAttempt = 0;
    this.setPhase("live");
    if (wasReconnect) {
      this.flushLanded();
      if (this.v3) this.resumed();
      return;
    }
    this.wentLive = true;
    this.startedAtMs = this.now();
    if (this.v3) this.refreshSpare();
    this.audio?.playConnectChime();
    this.openWithGreeting();
    this.emit();
  }

  private openWithGreeting(): void {
    // They already spoke: the model answers that and skips the greeting.
    if (this.callerSpokeLast || this.callerSpeaking) return;
    const direction = this.ticket?.plan.greeting.direction ?? null;
    // If the caller speaks first inside this window, the greeting is skipped.
    this.greetingTimer = this.timers.setTimeout(() => {
      this.greetingTimer = null;
      if (this.owed?.kind === "greeting") this.owed = null;
    }, GREETING_GRACE_MS);
    this.ask({ kind: "greeting", instructions: direction });
  }

  private cancelUserFirstOpen(): void {
    if (this.greetingTimer !== null) {
      this.timers.clearTimeout(this.greetingTimer);
      this.greetingTimer = null;
    }
    if (this.owed?.kind === "greeting") this.owed = null;
  }

  private handleClose(code: number, reason: string): void {
    this.socket = null;
    this.socketOpen = false;
    if (this.finished) return;
    const wasLive = this.phase === "live" || this.phase === "reconnecting" || this.phase === "ending";
    if (this.phase === "ending") {
      this.finish("idle");
      return;
    }
    if (!wasLive) {
      this.fail({
        code: "line_refused",
        title: "Couldn't reach xAI",
        detail: reason ? `xAI closed the line (${code}): ${reason}` : `xAI closed the line (${code}).`,
      });
      return;
    }
    if (code === CLOSE_POLICY || reason === "hang_up") {
      this.fail({
        code: "far_end",
        title: "xAI ended the call",
        detail: reason || "The voice service closed the line.",
      });
      return;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.finished) return;
    if (this.v3) {
      this.noteDrop();
      if (this.reconnectAttempt >= RESUME_MAX_ATTEMPTS || this.now() - (this.dropAt ?? this.now()) >= RESUME_MAX_MS) {
        this.giveUpResuming();
        return;
      }
    }
    const delay = reconnectDelayMs(this.reconnectAttempt);
    if (delay === null) {
      this.fail({
        code: "realtime_connection_failed",
        title: "The call dropped",
        detail: "BOS couldn't reconnect to xAI after 20 tries.",
      });
      return;
    }
    this.reconnectAttempt += 1;
    this.resetConnectionState();
    this.setPhase("reconnecting");
    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.finished) return;
      // v3 keeps one spare secret warm so a drop redials at once.
      const spare = this.v3 ? this.takeSpare() : null;
      if (spare) {
        this.ticket = { ...spare, plan: this.ticket?.plan ?? spare.plan };
        this.dial(spare.credential, true);
        return;
      }
      // A fresh secret on every dial: the old one may have expired.
      this.deps.mint().then(
        (ticket) => {
          if (this.finished || this.phase !== "reconnecting") return;
          this.ticket = { ...ticket, plan: this.ticket?.plan ?? ticket.plan };
          this.dial(ticket.credential, true);
        },
        (error: unknown) => {
          if (this.finished) return;
          if ((error as MintFailure | null)?.status === 409) this.fail(mintFailureToCallFailure(error));
          else this.scheduleReconnect();
        },
      );
    }, delay);
  }

  /** First close of a drop: count it, tell the server, start the 20 s clock. */
  private noteDrop(): void {
    if (this.dropAt !== null) return;
    this.dropAt = this.now();
    this.drops += 1;
    this.postEvent({ kind: "drop" });
    this.resumeTimer = this.timers.setTimeout(() => {
      this.resumeTimer = null;
      if (this.phase === "reconnecting") this.giveUpResuming();
    }, RESUME_MAX_MS);
  }

  /** Could not get the line back: end the call normally; the journal flushes later. */
  private giveUpResuming(): void {
    this.fault = "the line dropped and did not come back";
    this.finish("idle");
  }

  private resumed(): void {
    const ms = this.dropAt === null ? 0 : Math.max(0, this.now() - this.dropAt);
    this.dropAt = null;
    this.timers.clearTimeout(this.resumeTimer);
    this.resumeTimer = null;
    this.resumes += 1;
    this.postEvent({ kind: "resume", ms });
    this.ask({ kind: "turn", instructions: BACK_ON_LINE_TURN });
    void this.flushJobs();
    this.refreshSpare();
  }

  private takeSpare(): VoiceCallTicket | null {
    const spare = this.spare;
    this.spare = null;
    if (!spare || this.now() - spare.at > SPARE_MAX_AGE_MS) return null;
    return spare.ticket;
  }

  /** Mint the next spare secret now, and again every 240 s while the call lives. */
  private refreshSpare(): void {
    if (this.finished || this.spareRefreshing) return;
    this.spareRefreshing = true;
    this.deps.mint().then(
      (ticket) => {
        this.spareRefreshing = false;
        if (!this.finished) this.spare = { ticket, at: this.now() };
      },
      () => {
        this.spareRefreshing = false;
      },
    );
    this.timers.clearTimeout(this.spareTimer);
    this.spareTimer = this.timers.setTimeout(() => {
      this.spareTimer = null;
      if (this.phase === "live") this.refreshSpare();
      else this.spare = null;
    }, SPARE_MAX_AGE_MS);
  }

  private resetConnectionState(): void {
    this.dropSocket();
    this.timers.clearTimeout(this.dialTimer);
    this.dialTimer = null;
    this.responding = false;
    this.requested = false;
    this.talkedOver = false;
    this.spokeThisResponse = false;
    this.callerSpeaking = false;
    this.owed = null;
    this.cutsOwed = [];
    this.spans.clear();
    this.audio?.dropScheduled();
    this.closeOpenTurns();
  }

  private dropSocket(): void {
    const socket = this.socket;
    this.socket = null;
    this.socketOpen = false;
    this.invited = false;
    this.sessionReady = false;
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    try {
      socket.close(CLOSE_SUPERSEDED, "superseded");
    } catch {
      // Already closed.
    }
  }

  // ── events ─────────────────────────────────────────────────────────────

  private route(event: ServerEvent): void {
    switch (event.kind) {
      case "session_ready":
        this.sessionReady = true;
        this.maybeGoLive();
        return;
      case "conversation_created":
        // Keep the first conversation id: reconnects rejoin it.
        if (!this.conversationId) this.conversationId = event.id;
        return;
      case "response_created":
        this.responding = true;
        this.requested = false;
        this.talkedOver = false;
        this.spokeThisResponse = false;
        if (this.fault) this.fault = null;
        this.emit();
        return;
      case "response_done":
        this.responding = false;
        this.requested = false;
        if (this.cutsOwed.length > 0) {
          for (const cut of this.cutsOwed) this.send(truncateFrame(cut.itemId, cut.contentIndex, cut.audioEndMs));
          this.cutsOwed = [];
        }
        this.payOwed();
        this.checkGoodbye();
        this.emit();
        return;
      case "audio_delta":
        this.onAudioDelta(event.itemId, event.contentIndex, event.delta);
        return;
      case "speech_started":
        this.onSpeechStarted(event.itemId);
        return;
      case "speech_stopped":
        this.callerSpeaking = false;
        this.payOwed();
        this.emit();
        return;
      case "item_added":
        return;
      case "user_transcript": {
        const turn = this.turnFor(event.itemId, "user");
        // A settled line is kept once: a replayed delta never doubles it.
        if (turn.settled && !event.replace) return;
        turn.text = event.replace ? event.text : turn.text + event.text;
        if (event.final) turn.settled = true;
        this.emit();
        return;
      }
      case "user_transcript_failed": {
        const turn = this.turns.find((t) => t.id === event.itemId);
        if (turn) turn.settled = true;
        this.emit();
        return;
      }
      case "assistant_transcript_delta": {
        if (this.closedTurns.has(event.itemId)) return;
        const turn = this.turnFor(event.itemId, "assistant");
        turn.text += event.delta;
        this.spokeThisResponse = true;
        this.emit();
        return;
      }
      case "assistant_transcript_done": {
        if (this.closedTurns.has(event.itemId) || this.talkedOver) return;
        const turn = this.turnFor(event.itemId, "assistant");
        if (event.text) turn.text = event.text;
        turn.settled = true;
        this.closedTurns.add(event.itemId);
        this.emit();
        return;
      }
      case "item_truncated": {
        const turn = this.turns.find((t) => t.id === event.itemId);
        if (turn) {
          if (event.text !== null) turn.text = event.text;
          turn.settled = true;
          this.closedTurns.add(event.itemId);
        }
        this.emit();
        return;
      }
      case "function_call":
        this.onToolCall(event.callId, event.name, event.arguments);
        return;
      case "error":
        this.fault = event.message;
        this.emit();
        return;
      case "unsupported":
        return;
    }
  }

  private onAudioDelta(itemId: string, contentIndex: number, delta: string): void {
    // Late deltas after a barge-in are never played.
    if (this.talkedOver || this.callerSpeaking || !this.audio) return;
    const span = this.audio.schedule(pcm16Base64ToFloat32(delta));
    if (!span) return;
    this.spokeThisResponse = true;
    this.callerSpokeLast = false;
    if (this.firstAudioMs === undefined && this.startRequestedAt !== null) {
      this.firstAudioMs = Math.max(0, this.now() - this.startRequestedAt);
      if (this.v3) this.postEvent({ kind: "first_audio", ms: this.firstAudioMs });
    }
    const key = `${itemId}:${contentIndex}`;
    const existing = this.spans.get(key);
    if (existing) existing.endsAt = span.endsAt;
    else this.spans.set(key, { itemId, contentIndex, startsAt: span.startsAt, endsAt: span.endsAt });
    this.emit();
  }

  private onSpeechStarted(itemId: string | null): void {
    this.callerSpeaking = true;
    this.callerSpokeLast = true;
    if (itemId) this.turnFor(itemId, "user");
    if (this.responding || this.requested) {
      this.talkedOver = true;
      this.closeOpenTurns("assistant");
    }
    this.cancelUserFirstOpen();
    // callers hold: an owed turn is dropped, the caller's speech gets its own reply.
    this.owed = null;
    this.truncateWhatTheyNeverHeard();
    this.emit();
  }

  private truncateWhatTheyNeverHeard(): void {
    if (!this.audio) return;
    const cuts = truncationsFor(this.spans.values(), this.audio.currentTime());
    this.audio.dropScheduled();
    this.spans.clear();
    if (cuts.length === 0) return;
    if (this.responding) this.cutsOwed.push(...cuts);
    else for (const cut of cuts) this.send(truncateFrame(cut.itemId, cut.contentIndex, cut.audioEndMs));
  }

  private speechEnded(): void {
    this.spans.clear();
    this.payOwed();
    this.checkGoodbye();
    this.emit();
  }

  // ── responses ──────────────────────────────────────────────────────────

  private lineState() {
    return readTheLine({
      socketIsWritable: this.socketWritable(),
      callerIsSpeaking: this.callerSpeaking,
      responseIsInFlight: this.responding || this.requested,
      speakerIsBusy: this.audio?.isPlaying() ?? false,
    });
  }

  private ask(turn: OwedTurn): void {
    switch (this.lineState()) {
      case "dead":
        return;
      case "callers":
        // The greeting waits out its grace window; anything else is dropped.
        if (turn.kind === "greeting") this.owed = turn;
        return;
      case "busy":
        // A newer owed turn supersedes an older one.
        this.owed = turn;
        return;
      case "free":
        this.sendResponse(turn);
    }
  }

  private payOwed(): void {
    if (!this.owed || this.lineState() !== "free") return;
    const turn = this.owed;
    this.owed = null;
    this.sendResponse(turn);
  }

  private sendResponse(turn: OwedTurn): void {
    if (turn.kind === "greeting" && this.greetingTimer !== null) {
      this.timers.clearTimeout(this.greetingTimer);
      this.greetingTimer = null;
    }
    this.requested = true;
    this.send(responseCreateFrame(turn.instructions));
    this.emit();
  }

  // ── tools ──────────────────────────────────────────────────────────────

  private onToolCall(callId: string, name: string, rawArguments: string): void {
    const args = parseToolArguments(rawArguments);
    switch (name) {
      case "send_task":
        if (this.v3) this.sendTaskV3(callId, args);
        else this.sendTask(callId, args);
        return;
      case "confirm_job":
        if (this.v3) {
          this.confirmJob(callId, args);
          return;
        }
        this.send(functionOutputFrame(callId, { error: `There is no tool named ${name}.` }));
        this.ask({ kind: "turn", instructions: null });
        return;
      case "recall_text_messages": {
        let messages: RecalledMessage[] = [];
        try {
          messages = this.deps.host.recall();
        } catch {
          messages = [];
        }
        this.send(functionOutputFrame(callId, { messages }));
        this.ask({ kind: "turn", instructions: null });
        return;
      }
      case "stay_silent":
        if (this.callerSpokeLast) {
          this.send(functionOutputFrame(callId, { error: STAY_SILENT_ERROR }));
          this.ask({ kind: "turn", instructions: STAY_SILENT_ERROR });
        } else {
          this.send(functionOutputFrame(callId, {}));
        }
        return;
      case "end_the_call":
        this.send(functionOutputFrame(callId, { status: "hanging_up" }));
        this.endAfterGoodbye();
        return;
      default:
        if (this.v3 && !CLIENT_TOOLS.has(name) && this.ticket?.plan.tools.some((tool) => tool.name === name)) {
          this.serverTool(callId, name, args);
          return;
        }
        this.send(functionOutputFrame(callId, { error: `There is no tool named ${name}.` }));
        this.ask({ kind: "turn", instructions: null });
    }
  }

  // ── v3 tools: read back, confirm, journal ──────────────────────────────

  private reply(callId: string, output: unknown): void {
    this.send(functionOutputFrame(callId, output));
    this.ask({ kind: "turn", instructions: null });
  }

  /** The last thing the caller said, or null while no transcript has settled for it. */
  private lastCallerTranscript(): string | null {
    for (let i = this.turns.length - 1; i >= 0; i--) {
      const turn = this.turns[i];
      if (turn.speaker !== "user") continue;
      if (!turn.settled && !turn.text.trim()) return null;
      return turn.text;
    }
    return null;
  }

  private sendTaskV3(callId: string, args: Record<string, unknown>): void {
    const checked = validateTaskRequest(args, this.ticket?.plan.maxRequestChars ?? 2000);
    if (!checked.ok) {
      this.reply(callId, { error: checked.error });
      return;
    }
    if (!passesNoiseGate(checked.request, this.lastCallerTranscript())) {
      this.postEvent({ kind: "unclear" });
      this.reply(callId, { status: "unclear", say: UNCLEAR_SAY });
      return;
    }
    // The job is the request only: never the caller's own words on top of it.
    const jobId = this.deps.newJobId?.() ?? `${this.callId}-job-${++this.jobSeq}`;
    const bot = typeof args.bot === "string" && args.bot.trim() ? args.bot.trim() : undefined;
    const state: JobState = { job: { jobId, text: checked.request, ...(bot ? { bot } : {}) }, status: "said" };
    this.pendingJobs.set(jobId, state);
    this.jobStates.set(jobId, state);
    this.reply(callId, { status: "read_back", job_id: jobId, say: readBackSay(args.readback, checked.request) });
  }

  private confirmJob(callId: string, args: Record<string, unknown>): void {
    const jobId = typeof args.job_id === "string" ? args.job_id : "";
    const decision = args.decision;
    const pending = this.pendingJobs.get(jobId);
    if (decision === "cancel") {
      if (pending) {
        this.pendingJobs.delete(jobId);
        pending.status = "cancelled";
      }
      this.reply(callId, { status: "cancelled" });
      this.emit();
      return;
    }
    if (decision !== "go") {
      this.reply(callId, { error: 'decision must be "go" or "cancel".' });
      return;
    }
    const known = this.jobStates.get(jobId);
    if (!pending) {
      // A repeated go for a job already saved is still saved.
      if (known && known.status !== "cancelled" && known.status !== "said") this.reply(callId, { status: "saved", say: "saved." });
      else this.reply(callId, { status: "unknown_job", say: "which job?" });
      return;
    }
    try {
      // Durable before anything is sent: the journal write is the answer.
      this.deps.journal!.add({ callId: this.callId, botId: this.deps.botId, job: pending.job, at: this.now() });
    } catch {
      this.reply(callId, { status: "error", say: "couldn't save that. want to try again?" });
      return;
    }
    this.pendingJobs.delete(jobId);
    pending.status = "queued";
    this.reply(callId, { status: "saved", say: "saved." });
    this.emit();
    void this.flushJobs();
  }

  /** Push the journal to the server; what lands updates the call's job list. */
  flushJobs(): Promise<void> {
    const { journal, server } = this.deps;
    if (!journal || !server) return Promise.resolve();
    return flushJournal(journal, server).then(
      ({ results }) => {
        for (const result of results) {
          const state = this.jobStates.get(result.jobId);
          if (!state) continue;
          if (result.status === "sent" || result.status === "duplicate") {
            state.status = "sent";
            state.threadId = result.threadId ?? state.threadId;
            state.botId = result.botId ?? state.botId;
          }
        }
        this.emit();
      },
      () => undefined,
    );
  }

  private unsentJobs(): number {
    let count = 0;
    for (const state of this.jobStates.values()) if (state.status === "queued") count += 1;
    return count;
  }

  private sentJobIds(): string[] {
    return [...this.jobStates.values()].filter((s) => s.status === "queued" || s.status === "sent").map((s) => s.job.jobId);
  }

  /** Any non-client plan tool: answered by the server, 8 s at most. */
  private serverTool(callId: string, name: string, args: Record<string, unknown>): void {
    const server = this.deps.server!;
    let answered = false;
    const controller = new AbortController();
    const answer = (output: string) => {
      if (answered) return;
      answered = true;
      this.timers.clearTimeout(timer);
      this.send(functionOutputFrame(callId, output));
      this.ask({ kind: "turn", instructions: null });
    };
    const timer = this.timers.setTimeout(() => {
      controller.abort();
      answer(TOOL_TIMEOUT_TEXT);
    }, TOOL_TIMEOUT_MS);
    server
      .tool(
        { callId: this.callId, botId: this.deps.botId, name: name as VoiceToolName, args, jobIds: this.sentJobIds() },
        controller.signal,
      )
      .then(
        (response) => answer(typeof response?.output === "string" ? response.output : TOOL_TIMEOUT_TEXT),
        () => answer(TOOL_TIMEOUT_TEXT),
      );
  }

  private postEvent(event: VoiceCallEvent): void {
    const server = this.deps.server;
    if (!server) return;
    try {
      void server.event({ callId: this.callId, botId: this.deps.botId, event }).catch(() => undefined);
    } catch {
      // Counters are best effort.
    }
  }

  /** Everything the server needs to write the voice chat card. */
  endReport(): VoiceCallEndRequest {
    const endedAt = this.endedAtMs ?? this.now();
    const seconds = this.startedAtMs === null ? 0 : Math.max(0, Math.round((endedAt - this.startedAtMs) / 1000));
    const transcript: VoiceTranscriptLine[] = this.turns
      .filter((turn) => turn.text.trim().length > 0)
      .map((turn) => ({
        role: turn.speaker === "user" ? "user" : "bot",
        text: turn.text.trim(),
        at: this.turnAt.get(turn.id),
      }));
    return {
      callId: this.callId,
      botId: this.deps.botId,
      seconds,
      startedAt: this.startedAtMs ?? this.startRequestedAt ?? endedAt,
      transcript,
      jobs: [...this.jobStates.values()].map((state) => ({
        ...state.job,
        status: state.status,
        ...(state.threadId ? { threadId: state.threadId } : {}),
        ...(state.botId ? { botId: state.botId } : {}),
      })),
      metrics: {
        drops: this.drops,
        resumes: this.resumes,
        ...(this.firstAudioMs !== undefined ? { firstAudioMs: this.firstAudioMs } : {}),
      },
    };
  }

  private sendTask(callId: string, args: Record<string, unknown>): void {
    const maxChars = this.ticket?.plan.maxRequestChars ?? 2000;
    const checked = validateTaskRequest(args, maxChars);
    if (!checked.ok) {
      this.send(functionOutputFrame(callId, { error: checked.error }));
      this.ask({ kind: "turn", instructions: null });
      return;
    }
    // The receipt goes back at once; the job runs in the chat meanwhile.
    this.send(functionOutputFrame(callId, TASK_RECEIPT));
    if (!this.spokeThisResponse) this.ask({ kind: "turn", instructions: this.ticket?.plan.receiptTurn ?? null });
    this.pendingTasks += 1;
    this.emit();
    const failed = () => {
      if (this.finished) return;
      if (this.pendingTasks > 0) this.pendingTasks -= 1;
      this.ask({ kind: "turn", instructions: SEND_FAILED_TURN });
      this.emit();
    };
    try {
      this.deps.host.sendTask(checked.request, failed);
    } catch {
      failed();
    }
  }

  /** end_the_call: let the goodbye finish playing (max 15 s), then hang up. */
  private endAfterGoodbye(): void {
    if (this.goodbye || this.finished) return;
    this.setPhase("ending");
    const timer = this.timers.setTimeout(() => this.resolveGoodbye(), GOODBYE_MAX_MS);
    this.goodbye = { resolve: () => this.finish("idle"), timer };
    this.checkGoodbye();
  }

  private checkGoodbye(): void {
    if (!this.goodbye) return;
    if (this.responding || this.requested || this.audio?.isPlaying()) return;
    this.resolveGoodbye();
  }

  private resolveGoodbye(): void {
    const goodbye = this.goodbye;
    if (!goodbye) return;
    this.goodbye = null;
    this.timers.clearTimeout(goodbye.timer);
    goodbye.resolve();
  }

  // ── transcript ─────────────────────────────────────────────────────────

  private turnFor(itemId: string, speaker: TranscriptTurn["speaker"]): TranscriptTurn {
    let turn = this.turns.find((t) => t.id === itemId);
    if (!turn) {
      turn = { id: itemId, speaker, text: "", settled: false };
      this.turns.push(turn);
      this.turnAt.set(itemId, this.now());
    }
    return turn;
  }

  private closeOpenTurns(speaker?: TranscriptTurn["speaker"]): void {
    for (const turn of this.turns) {
      if (turn.settled || (speaker && turn.speaker !== speaker)) continue;
      turn.settled = true;
      this.closedTurns.add(turn.id);
    }
  }

  private settledTurns(): SettledTurn[] {
    return this.turns.filter((t) => t.settled && t.text.trim()).map((t) => ({ speaker: t.speaker, text: t.text }));
  }

  private flushLanded(): void {
    const queued = this.landedQueue;
    this.landedQueue = [];
    for (const item of queued) this.send(workLandedFrame(item.eventId, item.text, item.at));
  }

  // ── plumbing ───────────────────────────────────────────────────────────

  private sendFrame(samples: Float32Array): void {
    if (this.muted || !this.invited || !this.socketWritable()) return;
    this.send(appendFrame(floatToPcm16Base64(samples)));
  }

  private socketWritable(): boolean {
    return this.socket !== null && this.socket.readyState === OPEN;
  }

  private send(frame: string): void {
    if (!this.socketWritable()) return;
    try {
      this.socket!.send(frame);
    } catch {
      // The close handler takes it from here.
    }
  }

  private activity(): CallActivity {
    if (this.phase !== "live" && this.phase !== "ending") return "idle";
    if (this.callerSpeaking) return "listening";
    if (this.audio?.isPlaying()) return "streaming";
    if (this.responding || this.requested) return "thinking";
    return "idle";
  }

  private setPhase(phase: CallPhase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.emit();
  }

  private fail(failure: CallFailure): void {
    if (this.finished) return;
    this.failure = failure;
    this.finish("failed");
  }

  private finish(phase: "idle" | "failed"): void {
    if (this.finished) return;
    this.finished = true;
    this.endedAtMs = this.now();
    for (const timer of [
      this.micTimer,
      this.dialTimer,
      this.reconnectTimer,
      this.greetingTimer,
      this.goodbye?.timer,
      this.resumeTimer,
      this.spareTimer,
    ]) {
      if (timer !== null && timer !== undefined) this.timers.clearTimeout(timer);
    }
    this.goodbye = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      try {
        socket.close(CLOSE_NORMAL, "hang_up");
      } catch {
        // Already closed.
      }
    }
    this.audio?.close();
    if (this.wentLive) this.deps.playHangupChime?.();
    this.callerSpeaking = false;
    this.responding = false;
    this.requested = false;
    this.spare = null;
    this.phase = phase;
    this.emit();
    // Call end flushes whatever the journal still holds.
    if (this.v3 && this.jobStates.size > 0) void this.flushJobs();
    this.deps.onFinished?.(this.getSnapshot());
  }

  private emit(): void {
    this.snapshotCache = null;
    for (const listener of this.listeners) listener();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error ?? "Unknown error");
}
