// The one realtime call in this window. Lives outside React so the call
// survives navigating between chats; the UI subscribes to it.

import { useSyncExternalStore } from "react";

import { currentCall, endCall, startCall } from "@/lib/call";
import { track } from "@/lib/analytics";
import { api } from "@/state/store";

import { BrowserCallAudio, playHangupChime } from "./audio";
import { VoiceCallEngine, type CallHost, type CallSocket, type VoiceCallSnapshot } from "./engine";
import { VoiceEndQueue, VoiceJournal, type VoiceServer } from "./journal";
import { flushOutbox, settleCall, type Outbox } from "./outbox";
import { TOOL_TIMEOUT_MS, type VoiceCallTicket } from "./protocol";
import { loadVoiceSettings, saveVoiceSettings } from "./settings";

let active: VoiceCallEngine | null = null;
let host: CallHost | null = null;
const watchers = new Set<() => void>();

function notify() {
  for (const fn of Array.from(watchers)) fn();
}

/** The chat bridge (VoiceCallHost) registers itself here. */
export function registerCallHost(next: CallHost | null): void {
  host = next;
}

export function activeRealtimeCall(): VoiceCallEngine | null {
  return active;
}

export function isRealtimeCallFor(botId: string): boolean {
  return active !== null && active.botId === botId;
}

export function useRealtimeCall(): VoiceCallEngine | null {
  return useSyncExternalStore(
    (fn) => {
      watchers.add(fn);
      return () => watchers.delete(fn);
    },
    () => active,
    () => active,
  );
}

/** The v3 routes, over the same authenticated client as everything else. */
const voiceServer: VoiceServer = {
  jobs: (request) => api("/api/voice/jobs", { method: "POST", body: JSON.stringify(request), timeoutMs: 15_000 }),
  event: (request) => api("/api/voice/call/event", { method: "POST", body: JSON.stringify(request), timeoutMs: 8_000 }),
  tool: (request, signal) =>
    api("/api/voice/tool", { method: "POST", body: JSON.stringify(request), timeoutMs: TOOL_TIMEOUT_MS, signal }),
  end: (request) => api("/api/voice/call/end", { method: "POST", body: JSON.stringify(request), timeoutMs: 15_000 }),
};

// Both survive a reload: a confirmed job and a call-end report are owed to the
// server until it says so.
const journal = new VoiceJournal();
const ends = new VoiceEndQueue();
const outbox: Outbox = { journal, ends, server: voiceServer };

/** Quiet nudge when jobs from a call reach the server after the fact. */
function announceSent(count: number): void {
  if (active) return; // mid-call the engine already says so
  try {
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    new Notification(count === 1 ? "sent 1 job from your call" : `sent ${count} jobs from your call`);
  } catch { /* notifications are a courtesy */ }
}

/** Push whatever is owed: leftover jobs, call-end reports. Safe to call often. */
export function flushVoiceOutbox(): void {
  void flushOutbox(outbox, announceSent).catch(() => {});
}

// Prewarm (§8): a credential minted ahead of the tap. Only once a v3 server has
// answered, so an older server never books a throwaway mint.
const PREWARM_MAX_AGE_MS = 240_000;
const V3_SEEN_KEY = "bos.voice.v3seen";
let sawV3 = (() => {
  try { return localStorage.getItem(V3_SEEN_KEY) === "1"; } catch { return false; }
})();
let prewarmed: { botId: string; callId: string; at: number; ticket: Promise<VoiceCallTicket> } | null = null;

function mintTicket(botId: string, callId: string, prewarm: boolean): Promise<VoiceCallTicket> {
  const language = loadVoiceSettings(botId).language;
  return api<VoiceCallTicket>("/api/voice/call", {
    method: "POST",
    body: JSON.stringify(prewarm ? { botId, language, callId, prewarm: true, v: 3 } : { botId, language, callId, v: 3 }),
    timeoutMs: 20_000,
  }).then((ticket) => {
    if (ticket?.plan?.v === 3 && !sawV3) {
      sawV3 = true;
      try { localStorage.setItem(V3_SEEN_KEY, "1"); } catch { /* memory only */ }
    }
    return ticket;
  });
}

/** Hover / focus on the call button, or the voice panel opening. */
export function prewarmRealtimeCall(botId: string): void {
  if (!sawV3 || (active && active.botId === botId)) return;
  if (prewarmed && prewarmed.botId === botId && Date.now() - prewarmed.at < PREWARM_MAX_AGE_MS) return;
  const callId = crypto.randomUUID();
  const ticket = mintTicket(botId, callId, true);
  const entry = { botId, callId, at: Date.now(), ticket };
  prewarmed = entry;
  ticket.catch(() => {
    if (prewarmed === entry) prewarmed = null;
  });
}

/** The prewarmed ticket for this bot, if fresh, taken exactly once. */
function takePrewarm(botId: string): { callId: string; ticket: Promise<VoiceCallTicket> } | null {
  const entry = prewarmed;
  prewarmed = null;
  if (!entry || entry.botId !== botId || Date.now() - entry.at >= PREWARM_MAX_AGE_MS) return null;
  return entry;
}

if (typeof window !== "undefined") {
  window.addEventListener("focus", flushVoiceOutbox);
  window.addEventListener("online", flushVoiceOutbox);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") flushVoiceOutbox();
  });
  // Anything a closed window left behind.
  queueMicrotask(flushVoiceOutbox);
}

const noHost: CallHost = {
  sendTask: (_request, onFailed) => onFailed(),
  recall: () => [],
};

export function startRealtimeCall(botId: string): VoiceCallEngine {
  if (active && active.botId === botId && active.getSnapshot().phase !== "failed") return active;
  active?.hangUp();
  void track("call_started", { mode: "realtime" });
  flushVoiceOutbox();
  // One id for the whole call, reconnects included, so the server books it once.
  // A prewarmed ticket brings its own id; the first mint hands it over.
  const warm = takePrewarm(botId);
  const callId = warm?.callId ?? crypto.randomUUID();
  let firstTicket = warm?.ticket ?? null;
  const engine: VoiceCallEngine = new VoiceCallEngine({
    botId,
    callId,
    server: voiceServer,
    journal,
    mint: async () => {
      if (firstTicket) {
        const pending = firstTicket;
        firstTicket = null;
        // A prewarm that failed is no reason to fail the call: mint again.
        try {
          return await pending;
        } catch { /* fall through */ }
      }
      return mintTicket(botId, callId, false);
    },
    openSocket: (url, protocols) => new WebSocket(url, protocols) as unknown as CallSocket,
    createAudio: () => new BrowserCallAudio(),
    host: {
      sendTask: (request, onFailed) => (host ?? noHost).sendTask(request, onFailed),
      recall: () => (host ?? noHost).recall(),
    },
    loadSettings: (options) => loadVoiceSettings(botId, options),
    saveSettings: (settings) => saveVoiceSettings(botId, settings),
    playHangupChime,
    onFinished: (snapshot: VoiceCallSnapshot) => {
      endCall(botId);
      reportCallLength(callId, snapshot.startedAtMs);
      // Always: a call that never connected still gets its end report.
      void settleCall(engine, outbox).catch(() => {});
      // A failure keeps the card up until dismissed; a hang-up just goes.
      if (snapshot.phase !== "failed" && active === engine) {
        active = null;
        notify();
      }
    },
  });
  active = engine;
  setCallPopoverHidden(false);
  // Own the line so auto-speak and the old call mode stand down.
  startCall(botId);
  notify();
  engine.start();
  return engine;
}

/** Tell the server how long the line was up (Settings → Usage, xAI voice).
 * Seconds only; a call that never connected has nothing to book. */
function reportCallLength(callId: string, startedAtMs: number | null): void {
  if (startedAtMs === null) return;
  const seconds = Math.max(0, (Date.now() - startedAtMs) / 1000);
  void api("/api/voice/call/usage", { method: "POST", body: JSON.stringify({ callId, seconds }) }).catch(() => {});
}

export function hangUpRealtimeCall(): void {
  active?.hangUp();
}

/** Close the failure card. */
export function dismissRealtimeCall(): void {
  if (!active) return;
  const engine = active;
  if (engine.getSnapshot().phase === "failed") engine.dismiss();
  else engine.hangUp();
  if (active === engine) {
    active = null;
    notify();
  }
}

/** Another call took the line (old call mode, a room call): hang up. */
export function yieldLineIfTaken(): void {
  if (!active) return;
  const owner = currentCall();
  const phase = active.getSnapshot().phase;
  if (phase === "failed" || phase === "idle") return;
  if (owner !== active.botId) active.hangUp();
}

// The popover can be tucked away while the call keeps running; the header
// chip brings it back.
let popoverHidden = false;
const popoverWatchers = new Set<() => void>();

export function setCallPopoverHidden(hidden: boolean): void {
  if (popoverHidden === hidden) return;
  popoverHidden = hidden;
  for (const fn of Array.from(popoverWatchers)) fn();
}

export function useCallPopoverHidden(): boolean {
  return useSyncExternalStore(
    (fn) => {
      popoverWatchers.add(fn);
      return () => popoverWatchers.delete(fn);
    },
    () => popoverHidden,
    () => popoverHidden,
  );
}
