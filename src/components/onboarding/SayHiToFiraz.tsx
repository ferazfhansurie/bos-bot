import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { MausAvatar } from "@/components/Avatar";
import { helloName, HELLO_NAME_MAX, openHello, sayHi } from "@/lib/welcome-chat";
import { api, useStore } from "@/state/store";
import { inputClass, PrimaryButton, QuietButton } from "./beats/shared";

/** The step after first run: a private room with Firaz and his bot, who help
 * set up the team. On by default, one tap to skip, and it never blocks the
 * app: if Firaz's server is offline the card just goes away. */
export function SayHiToFiraz({ onDone }: { onDone: () => void }) {
  const { state } = useStore();
  const [name, setName] = useState(() => helloName(state.config?.profile?.name));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [link, setLink] = useState("");
  const card = useRef<HTMLDivElement>(null);
  const pending = useRef(false);
  const trimmed = helloName(name);

  useEffect(() => {
    card.current?.querySelector<HTMLElement>("input")?.focus({ preventScroll: true });
  }, []);

  const hello = async () => {
    if (pending.current || !trimmed) return;
    pending.current = true;
    setBusy(true);
    setMessage("");
    try {
      const outcome = await sayHi(trimmed, api);
      if (outcome.kind === "hide") return onDone();
      if (outcome.kind === "later") return setMessage(outcome.message);
      if (await openHello(outcome.url)) return onDone();
      // A browser blocked the tab: hand over the link instead.
      setLink(outcome.url);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onDone();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-app/95 p-5" ref={card} onKeyDown={onKeyDown} role="dialog" aria-modal="true" aria-label="Say hi to Firaz">
      <div className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-3xl border border-hairline bg-panel p-7">
        <div className="flex items-center gap-4">
          <MausAvatar color="green" size={60} state="happy" label="BOS" />
          <h1 className="text-xl font-semibold">Say hi to Firaz</h1>
        </div>
        <p className="mt-5 text-sm leading-relaxed text-ink-secondary">
          Firaz made BOS. Open a private chat with him and his bot, and they'll help you set up your team: which AI you already have, and what you want to build first. Only the three of you are in it.
        </p>
        {link ? (
          <a href={link} target="_blank" rel="noreferrer" onClick={onDone} className="mt-5 block w-full rounded-lg bg-accent py-2.5 text-center text-[15px] font-medium text-white">
            Open the chat
          </a>
        ) : (
          <>
            <label className="mt-5 block text-sm">
              Your name
              <input
                value={name}
                maxLength={HELLO_NAME_MAX}
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => event.key === "Enter" && void hello()}
                placeholder="What should they call you?"
                className={`${inputClass} mt-2`}
              />
            </label>
            {message && <p role="alert" className="mt-3 text-sm text-warning">{message}</p>}
            <PrimaryButton className="mt-5" disabled={busy || !trimmed} onClick={() => void hello()}>
              {busy ? "Saying hi…" : "Say hi"}
            </PrimaryButton>
          </>
        )}
        <div className="mt-4 flex justify-center">
          <QuietButton disabled={busy} onClick={onDone}>Skip</QuietButton>
        </div>
      </div>
    </div>
  );
}
