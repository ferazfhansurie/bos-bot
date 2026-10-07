// Bridges the realtime call to the bot's written chat. Mounted once inside
// the store so it outlives any one ChatView: send_task posts through the
// normal send path, recall_text_messages reads the chat, and the bot's
// replies to jobs sent from the call ride back in as work_landed.

import { useEffect, useRef } from "react";

import { useOnCall } from "@/lib/call";
import { capLandedText, landedReplies, recallMessages } from "@/lib/voice-call/chat-bridge";
import { registerCallHost, useRealtimeCall, yieldLineIfTaken } from "@/lib/voice-call/session";
import { useStore, visibleMessages, type Bot } from "@/state/store";

import { useCallSnapshot } from "./VoiceCall";

interface Watch {
  botId: string;
  threadId: string;
  /** Bot messages that already existed, or were already spoken. */
  delivered: Set<string>;
}

export function VoiceCallHost() {
  const { state, dispatch } = useStore();
  const engine = useRealtimeCall();
  const snapshot = useCallSnapshot(engine);
  const onCall = useOnCall();
  const stateRef = useRef(state);
  stateRef.current = state;
  const engineRef = useRef(engine);
  engineRef.current = engine;
  const watch = useRef<Watch | null>(null);

  const botFor = (botId: string): Bot | undefined => stateRef.current.bots.find((b) => b.id === botId);

  useEffect(() => {
    registerCallHost({
      sendTask: (request, onFailed) => {
        const current = engineRef.current;
        const bot = current ? botFor(current.botId) : undefined;
        if (!current || !bot) {
          onFailed();
          return;
        }
        // Pin the thread the first job went to; replies are read from there.
        if (!watch.current || watch.current.botId !== bot.id) {
          watch.current = {
            botId: bot.id,
            threadId: bot.threadId,
            delivered: new Set(bot.messages.map((m) => m.id)),
          };
        }
        dispatch({ type: "send", botId: bot.id, text: request, threadId: watch.current.threadId, onError: onFailed });
      },
      recall: () => {
        const current = engineRef.current;
        const bot = current ? botFor(current.botId) : undefined;
        return bot ? recallMessages(visibleMessages(bot)) : [];
      },
    });
    return () => registerCallHost(null);
  }, [dispatch]);

  // A new call starts with nothing watched.
  useEffect(() => {
    watch.current = null;
  }, [engine]);

  // Another call took the line: hang this one up.
  useEffect(() => {
    yieldLineIfTaken();
  }, [onCall]);

  // Work landed: the bot answered a job sent from this call.
  useEffect(() => {
    const current = watch.current;
    if (!engine || !current || engine.botId !== current.botId) return;
    if (snapshot.phase !== "live" && snapshot.phase !== "reconnecting") return;
    const bot = state.bots.find((b) => b.id === current.botId);
    if (!bot || bot.threadId !== current.threadId) return;
    const landed = landedReplies({
      messages: visibleMessages(bot),
      sinceAt: 0,
      busy: Boolean(bot.busy),
      delivered: current.delivered,
    });
    for (const message of landed) {
      current.delivered.add(message.id);
      engine.workLanded(capLandedText(message.text ?? ""));
    }
  }, [state.bots, engine, snapshot.phase]);

  return null;
}
