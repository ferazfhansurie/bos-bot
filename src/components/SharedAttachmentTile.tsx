import { useEffect, useState } from "react";
import { Paperclip } from "lucide-react";
import { api } from "@/state/store";

export interface SharedAttachment { id: string; name: string; mime: string; size: number }

export function SharedAttachmentTile({ roomId, attachment }: { roomId: string; attachment: SharedAttachment }) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const isImage = attachment.mime.startsWith("image/");
  const isVideo = attachment.mime.startsWith("video/");
  useEffect(() => {
    if (!isImage && !isVideo) return;
    let alive = true;
    let objectUrl = "";
    void api<{ data: string }>(`/api/multiplayer/rooms/${roomId}/attachments/${attachment.id}`).then(result => {
      if (!alive) return;
      const bytes = Uint8Array.from(atob(result.data), character => character.charCodeAt(0));
      objectUrl = URL.createObjectURL(new Blob([bytes], { type: attachment.mime }));
      setUrl(objectUrl);
    }).catch(() => { if (alive) setError("Preview unavailable"); });
    return () => { alive = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [roomId, attachment.id, attachment.mime, isImage, isVideo]);
  const download = async () => {
    try {
      let target = url;
      if (!target) {
        const result = await api<{ data: string }>(`/api/multiplayer/rooms/${roomId}/attachments/${attachment.id}`);
        const bytes = Uint8Array.from(atob(result.data), character => character.charCodeAt(0));
        target = URL.createObjectURL(new Blob([bytes], { type: attachment.mime }));
      }
      const link = document.createElement("a");
      link.href = target; link.download = attachment.name; link.click();
      if (target !== url) window.setTimeout(() => URL.revokeObjectURL(target), 60_000);
      setError("");
    } catch { setError("Could not download attachment"); }
  };
  return <div className="mt-1 max-w-full overflow-hidden rounded-xl bg-card">
    {url && isImage && <img src={url} alt={attachment.name} className="max-h-80 max-w-full object-contain" />}
    {url && isVideo && <video src={url} controls preload="metadata" className="max-h-80 max-w-full" />}
    <button type="button" onClick={() => void download()} className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] hover:bg-raised/70">
      <Paperclip size={15} /><span className="truncate">{attachment.name}</span>
    </button>
    {error && <span role="alert" className="block px-3 pb-2 text-xs text-danger">{error}</span>}
  </div>;
}
