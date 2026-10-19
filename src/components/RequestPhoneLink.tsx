import { useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { api } from "@/state/store";
export function RequestPhoneLink({ botId, threadId, messageId, requestId }: { botId: string; threadId: string; messageId: string; requestId: string }) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const open = async () => {
    setBusy(true); setError("");
    try {
      const result = await api<{ url: string }>(`/api/bots/${encodeURIComponent(botId)}/request-continuation?${new URLSearchParams({ threadId, messageId, requestId })}`);
      setUrl(result.url);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "could not open this request"); }
    finally { setBusy(false); }
  };
  return <div className="mt-2 text-[12px] text-ink-secondary">
    <button type="button" disabled={busy} onClick={() => url ? setUrl("") : void open()} className="text-accent-text">{url ? "hide phone link" : "continue on phone"}</button>
    {url && <div className="mt-2 rounded-lg border border-hairline/40 p-3">
      <p className="mb-2">scan with the iphone already paired to this computer. this opens the request; it does not answer it.</p>
      <QRCodeSVG value={url} size={144} level="M" bgColor="#fff" fgColor="#111" />
      <button className="mt-2 text-accent-text" onClick={() => void navigator.clipboard.writeText(url).then(() => setCopied(true)).catch(() => setError("could not copy the phone link"))}>{copied ? "copied" : "copy phone link"}</button>
    </div>}
    {error && <p role="alert" className="mt-1 text-danger">{error}</p>}
  </div>;
}
