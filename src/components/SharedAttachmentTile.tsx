import { useEffect, useState } from "react";
import { Download } from "lucide-react";
import { api } from "@/state/store";
import { cn } from "@/lib/cn";
import { AttachmentPreviewDialog, AttachmentThumbnail, singleImageMaxWidth, type PreviewImage } from "./AttachmentPreview";
import { FileKindIcon, fileTypeLabel, MEDIA_PLACEHOLDER, MEDIA_RING, MEDIA_TEXT_SECONDARY, MediaKeyframes } from "./MediaTokens";

export interface SharedAttachment { id: string; name: string; mime: string; size: number }

export function formatAttachmentSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export function SharedAttachmentTile({ roomId, attachment, compact = false }: { roomId: string; attachment: SharedAttachment; compact?: boolean }) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [aspect, setAspect] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const isImage = attachment.mime.startsWith("image/");
  const isVideo = attachment.mime.startsWith("video/");
  useEffect(() => {
    if (compact || (!isImage && !isVideo)) return;
    let alive = true;
    let objectUrl = "";
    void api<{ data: string }>(`/api/multiplayer/rooms/${roomId}/attachments/${attachment.id}`).then(result => {
      if (!alive) return;
      const bytes = Uint8Array.from(atob(result.data), character => character.charCodeAt(0));
      objectUrl = URL.createObjectURL(new Blob([bytes], { type: attachment.mime }));
      setUrl(objectUrl);
    }).catch(() => { if (alive) setError("Preview unavailable"); });
    return () => { alive = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [roomId, attachment.id, attachment.mime, isImage, isVideo, compact]);
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

  const size = formatAttachmentSize(attachment.size);
  const header = (
    <button
      type="button"
      onClick={() => void download()}
      aria-label={`Download ${attachment.name}`}
      className="group/resource-card relative flex w-full items-center gap-2 p-2.5 pe-10 text-left transition-colors hover:bg-[color-mix(in_srgb,var(--color-ink)_3%,transparent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60"
    >
      <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-[12.5px] bg-inset", MEDIA_TEXT_SECONDARY)}>
        <FileKindIcon name={attachment.name} size={20} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12px] leading-[18px] font-semibold text-ink">{attachment.name}</span>
        <span className={cn("block truncate text-[12px] leading-[18px]", MEDIA_TEXT_SECONDARY)}>{size ? `${fileTypeLabel(attachment.name)} · ${size}` : fileTypeLabel(attachment.name)}</span>
      </span>
      <span className={cn("pointer-events-none absolute end-3 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center opacity-0 transition-opacity group-hover/resource-card:opacity-100 group-focus-visible/resource-card:opacity-100 [@media(hover:none)]:opacity-100", MEDIA_TEXT_SECONDARY)} aria-hidden="true">
        <Download size={16} />
      </span>
    </button>
  );
  const errorLine = error && <span role="alert" className="block px-3 pb-2 text-[12px] leading-4 text-danger">{error}</span>;

  if (url && isImage) {
    const image: PreviewImage = { src: url, name: attachment.name, downloadUrl: url, downloadName: attachment.name };
    return <div className={cn("mt-1 w-full", singleImageMaxWidth(aspect))}>
      <MediaKeyframes />
      <AttachmentThumbnail
        key={url}
        image={image}
        onPreview={() => setOpen(true)}
        onAspect={setAspect}
        style={aspect ? { aspectRatio: String(aspect) } : undefined}
        downloadable
        eager
      />
      {errorLine}
      {open && <AttachmentPreviewDialog image={image} onClose={() => setOpen(false)} />}
    </div>;
  }

  const pendingPreview = !compact && (isImage || isVideo) && !url && !error;
  return <div className={cn("mt-1 max-w-full overflow-hidden rounded-[20px] bg-raised", compact ? "w-full" : "w-[320px]", MEDIA_RING)}>
    <MediaKeyframes />
    {pendingPreview && <div className={cn("aspect-video w-full", MEDIA_PLACEHOLDER)} role="status"><span className="sr-only">Loading {attachment.name}</span></div>}
    {url && isVideo && <video src={url} controls playsInline preload="metadata" aria-label={attachment.name} className="block aspect-video w-full bg-black object-contain" />}
    {header}
    {errorLine}
  </div>;
}
