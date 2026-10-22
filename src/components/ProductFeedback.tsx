import { useRef, useState } from "react";
import { api } from "@/state/store";
import { sendProductFeedback } from "@/lib/product-feedback";

/** Consent is per submission. Never populate this form from a conversation. */
export function ProductFeedback({ rating, onSent }: { rating?: "up" | "down"; onSent?: () => void }) {
  const [text, setText] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState(false);
  const pending = useRef(false);
  const submit = async () => {
    if (pending.current || !consent || (!rating && !text.trim())) return;
    pending.current = true;
    setBusy(true);
    setError(false);
    try {
      await sendProductFeedback({ text: rating ? "" : text, rating, consent }, api);
      setSent(true);
      setText("");
      setConsent(false);
      onSent?.();
    } catch { setError(true); }
    finally { pending.current = false; setBusy(false); }
  };
  if (sent) return <p role="status" className="text-sm text-success">Thanks — your feedback was sent to Firaz.</p>;
  return <form className="mt-3 space-y-3" onSubmit={event => { event.preventDefault(); void submit(); }}>
    {!rating && <label className="block text-sm text-ink">Your feedback
      <textarea value={text} maxLength={2000} rows={4} disabled={busy} onChange={event => setText(event.target.value)} placeholder="What worked, or what should BOS improve?" className="mt-2 w-full resize-y rounded-lg border border-hairline bg-inset p-3 text-sm text-ink" />
    </label>}
    <p className="text-xs leading-relaxed text-ink-secondary">{rating ? "Only this thumbs-up or thumbs-down rating and your installation ID will be sent. No message text, message ID or conversation is included." : "Only the note you write here and your installation ID will be sent. Leave out passwords, keys and private conversations."}</p>
    <label className="flex items-start gap-2 text-sm text-ink">
      <input type="checkbox" checked={consent} disabled={busy} onChange={event => setConsent(event.target.checked)} className="mt-0.5" />
      <span>{rating ? "Share this rating with Firaz" : "Share this note with Firaz"}</span>
    </label>
    <button type="submit" disabled={!consent || busy || (!rating && !text.trim())} className="ui-button">{busy ? "Sending…" : "Send feedback"}</button>
    {error && <p role="alert" className="text-sm text-danger">Could not send feedback. Your choice is saved here so you can try again.</p>}
  </form>;
}
