// ChatView's call slot: the realtime voice call when xAI is configured,
// otherwise the original speech-to-text + TTS call mode.

import { CallButton, CallOverlay } from "@/components/CallView";
import { useOnCall } from "@/lib/call";
import { useRealtimeCall } from "@/lib/voice-call/session";
import { useStore, type Bot } from "@/state/store";

import { RealtimeCallControl, VoiceCallPopover, callIsOn, useCallSnapshot } from "./VoiceCall";

export function realtimeCallsAvailable(config: { xai?: { configured: boolean } } | null | undefined): boolean {
  return config?.xai?.configured === true;
}

export function BotCallButton({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const engine = useRealtimeCall();
  const snapshot = useCallSnapshot(engine);
  const onCall = useOnCall();
  const realtimeOn = engine !== null && callIsOn(snapshot);
  // An old-style call in progress keeps its own hang-up button.
  const legacyCallHere = onCall === bot.id && !realtimeOn;
  if (!realtimeOn && (legacyCallHere || !realtimeCallsAvailable(state.config))) return <CallButton bot={bot} />;
  const callee = engine ? state.bots.find((b) => b.id === engine.botId) : undefined;
  return (
    <RealtimeCallControl
      bot={bot}
      callee={callee}
      onSelectCallee={(id) => dispatch({ type: "select", id })}
    />
  );
}

export function BotCallOverlay({ bot }: { bot: Bot }) {
  return (
    <>
      <CallOverlay bot={bot} />
      <VoiceCallPopover bot={bot} />
    </>
  );
}
