// The one realtime call in this window. Lives outside React so the call
// survives navigating between chats; the UI subscribes to it.

import { useSyncExternalStore } from "react";

import { currentCall, endCall, startCall } from "@/lib/call";
import { track } from "@/lib/analytics";
import { api } from "@/state/store";

import { BrowserCallAudio, playHangupChime } from "./audio";
import { VoiceCallEngine, type CallHost, type CallSocket, type VoiceCallSnapshot } from "./engine";
import type { VoiceCallTicket } from "./protocol";
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

const noHost: CallHost = {
  sendTask: (_request, onFailed) => onFailed(),
  recall: () => [],
};

export function startRealtimeCall(botId: string): VoiceCallEngine {
  if (active && active.botId === botId && active.getSnapshot().phase !== "failed") return active;
  active?.hangUp();
  void track("call_started", { mode: "realtime" });
  // One id for the whole call, reconnects included, so the server books it once.
  const callId = crypto.randomUUID();
  const engine: VoiceCallEngine = new VoiceCallEngine({
    botId,
    mint: async () => {
      const language = loadVoiceSettings(botId).language;
      return api<VoiceCallTicket>("/api/voice/call", {
        method: "POST",
        body: JSON.stringify({ botId, language, callId }),
        timeoutMs: 20_000,
      });
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
