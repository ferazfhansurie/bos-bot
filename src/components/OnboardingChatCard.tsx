// The cards under bos's own onboarding lines (shared/onboarding-chat.ts).
// The engine card is the sign-in list from onboarding, inline in the chat, and
// it folds to one line once any engine is ready. The suggestions card sends a
// starter job as the person's own message, so it runs like anything they type.
import { useEffect, useRef } from "react";
import { Check } from "lucide-react";
import { EnginesBeat } from "./onboarding/beats/EnginesBeat";
import { engineReady } from "./EngineLibrary";
import { api, signInBeforeSend, useStore, type Bot, type Message } from "@/state/store";

function EngineCard() {
  const { state } = useStore();
  const ready = state.instances.find(engineReady);
  const wasReady = useRef(Boolean(ready));
  // A sign-in finished here: one inventory read lets the server move the
  // bot onto that engine and answer anything held while it was signed out.
  useEffect(() => {
    if (ready && !wasReady.current) void api("/api/instances").catch(() => {});
    wasReady.current = Boolean(ready);
  }, [ready]);
  if (ready) {
    const name = ready.driverKind === "codex" ? "ChatGPT" : ready.driverKind === "claudeAgent" ? "Claude" : ready.displayName;
    return (
      <div className="flex items-center gap-2 text-[13px] text-success">
        <Check size={14} strokeWidth={2.5} />
        <span>{ready.driverKind === "openrouter-free" ? `Using ${name}, free to start. Change the model any time.` : `Signed in with ${name}`}</span>
      </div>
    );
  }
  return (
    <div className="w-full max-w-[520px] rounded-2xl border border-hairline/40 bg-card px-4 py-3.5">
      <EnginesBeat inline onNext={() => {}} setMascot={() => {}} bump={() => {}} />
    </div>
  );
}

function Suggestions({ bot, message }: { bot: Bot; message: Message }) {
  const { state, dispatch } = useStore();
  const card = message.onboarding?.card;
  // a tap is a send, and nothing sends until an engine is signed in
  const waiting = signInBeforeSend(state, bot.id);
  if (card?.kind !== "suggestions") return null;
  // once the person has said anything, the menu has done its job
  if (bot.messages.some((m) => m.role === "user" && m.at > message.at)) return null;
  return (
    <div className="flex w-full max-w-[520px] flex-wrap gap-2">
      {card.items.map((item) => (
        <button
          key={item.id}
          type="button"
          disabled={waiting}
          title={waiting ? "Turn on BOS AI or connect Claude or ChatGPT first" : undefined}
          onClick={() => dispatch({ type: "send", botId: bot.id, threadId: bot.threadId, text: item.prompt, sendId: `onb_${item.id}_${crypto.randomUUID()}` })}
          className="rounded-full border border-hairline px-3.5 py-1.5 text-left text-[13.5px] text-ink transition-[background-color,transform] hover:bg-raised active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50"
        >
          {item.title}
        </button>
      ))}
    </div>
  );
}

/** Null when the message carries no card this renderer owns. */
export function OnboardingChatCard({ bot, message }: { bot: Bot; message: Message }) {
  const kind = message.onboarding?.card?.kind;
  if (bot.remote) return null;
  if (kind === "engine") return <EngineCard />;
  if (kind === "suggestions") return <Suggestions bot={bot} message={message} />;
  return null;
}
