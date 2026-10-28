// Voice calls v3: the wire between the phone/desktop call engine and the
// server. Spec: plans/voice-v3/contract.md.
//
// A call is one xAI realtime session. The client mints it with
// POST /api/voice/call, then talks to the server only through the routes
// below. Jobs never ride the chat send path any more: a confirmed job goes
// to POST /api/voice/jobs, which opens one thread per job on the right bot.

/** One line of the call transcript, kept by the client. */
export interface VoiceTranscriptLine {
  role: "user" | "bot";
  text: string;
  /** ms since epoch */
  at?: number;
}

export type VoiceJobStatus = "said" | "confirmed" | "queued" | "sent" | "cancelled" | "failed";

/** A job the caller confirmed on the call (or listed from a memo). */
export interface VoiceJob {
  /** Client-made id, stable across retries: the server is idempotent on it. */
  jobId: string;
  /** The request as the voice model restated it, one or two sentences. */
  text: string;
  /** Bot the job was routed to (id or name as the plan's roster gives it). */
  bot?: string;
}

/** POST /api/voice/jobs. Safe to resend: a jobId that already landed answers
 * with the same thread. */
export interface VoiceJobsRequest {
  callId: string;
  /** The bot that was called. */
  botId: string;
  jobs: VoiceJob[];
}

export interface VoiceJobResult {
  jobId: string;
  status: "sent" | "duplicate" | "failed";
  botId?: string;
  botName?: string;
  threadId?: string;
  error?: string;
}

/** POST /api/voice/call/summary: the screen a call ends on. */
export interface VoiceCallSummaryRequest {
  callId: string;
  botId: string;
  seconds: number;
}

/** A job given on the call, as it stands now. */
export interface VoiceCallSummaryJob {
  jobId: string;
  text: string;
  botId: string;
  botName: string;
  threadId: string;
  /** working: running or queued; needs_you: waiting on the owner; done: idle or closed */
  state: "working" | "needs_you" | "done";
  /** the newest bot line, plain text */
  last?: string;
}

export interface VoiceCallSummaryResponse {
  /** this call's rough cost, rm */
  rm: number;
  rmPerMinute: number;
  /** this month's voice calls, our own tally */
  month: { calls: number; seconds: number; rm: number };
  /** xAI prepaid credits, US cents; null without a management key or when
   * xAI's billing could not be read */
  credits: { remainingCents: number; usedCents: number; purchasedCents: number; fetchedAt: number | null } | null;
  /** true when a management key is saved (credits may still be null) */
  creditsConfigured: boolean;
  jobs: VoiceCallSummaryJob[];
}

export interface VoiceJobsResponse {
  results: VoiceJobResult[];
}

/** POST /api/voice/call/event. Counters for the /data voice card. */
export type VoiceCallEvent =
  | { kind: "start" }
  | { kind: "first_audio"; ms: number }
  | { kind: "drop" }
  | { kind: "resume"; ms: number }
  | { kind: "unclear" }
  | { kind: "memo" }
  | { kind: "rating"; good: boolean };

export interface VoiceCallEventRequest {
  callId: string;
  botId: string;
  event: VoiceCallEvent;
}

/** Fast read tools answered on the call (POST /api/voice/tool). */
export type VoiceToolName =
  | "check_jobs"
  | "recall_memory"
  | "calendar"
  | "status"
  | "needs_me"
  | "answer_item"
  | "follow_up";

export interface VoiceToolRequest {
  callId: string;
  botId: string;
  name: VoiceToolName;
  args: Record<string, unknown>;
  /** jobIds this call already sent, so check_jobs can find them. */
  jobIds?: string[];
}

export interface VoiceToolResponse {
  /** Plain text the voice model reads from; already short. */
  output: string;
}

export interface VoiceCallMetrics {
  drops: number;
  resumes: number;
  firstAudioMs?: number;
  inputRoute?: string;
  outputRoute?: string;
  mic?: "phone" | "car";
}

/** POST /api/voice/call/end, sent once when the call is over (the client
 * retries until it lands; callId makes it idempotent). */
export interface VoiceCallEndRequest {
  callId: string;
  botId: string;
  seconds: number;
  startedAt: number;
  transcript: VoiceTranscriptLine[];
  jobs: Array<VoiceJob & { status: VoiceJobStatus; threadId?: string; botId?: string }>;
  metrics: VoiceCallMetrics;
}

export interface VoiceCallEndResponse {
  threadId: string;
  messageId: string;
}

/** Payload of the "voice chat" card message (kind "text" + voiceCall, so an
 * older client shows the plain text). */
export interface VoiceCallCard {
  callId: string;
  botId: string;
  startedAt: number;
  seconds: number;
  transcript: VoiceTranscriptLine[];
  jobs: Array<{ jobId: string; text: string; botId?: string; botName?: string; threadId?: string; status: VoiceJobStatus }>;
  /** one line, made after the call */
  summary?: string;
  drops: number;
  resumes: number;
  rating?: "good" | "bad";
}

/** The world brief the call starts with (also folded into plan.instructions). */
export interface VoiceBrief {
  text: string;
  builtAt: number;
}
