import { AudioAttachment } from "./AudioAttachment";
import { isAudioFilename, matchingTranscript } from "@/lib/audio-transcript";
// A compact message-level gallery. Image pixels keep the existing attachment
// path validation; local files and videos only load after an explicit action
// through the server's exact-message file authorization.
import { useEffect, useMemo, useRef, useState } from "react";
import { fromMarkdown } from "mdast-util-from-markdown";
import { ChevronDown, ChevronUp, Images, LoaderCircle, Maximize2, Play, RotateCcw, X } from "lucide-react";
import { attachmentBasename, FILE_MAX_BYTES, type TranscriptFileAttachment, type TranscriptImageAttachment } from "@/lib/composer-attachments";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { windowsPathDestinations } from "../../shared/markdown-windows-paths";
import { localFilePath } from "./ChatMarkdown";
import {
  AttachedFileChip,
  AttachmentPreviewDialog,
  AttachmentThumbnail,
  MediaLightbox,
  previewImage,
  requestMessageFile,
  safeDownloadFilename,
  singleImageMaxWidth,
  type MessageAttachmentContext,
  type PreviewImage,
} from "./AttachmentPreview";
import { MEDIA_OVERLAY_CONTROL, MEDIA_RING, MEDIA_TEXT_TERTIARY, MediaKeyframes } from "./MediaTokens";

export interface GalleryFile extends TranscriptFileAttachment {
  /** The file came from a rendered Markdown link rather than a user upload. */
  linked?: boolean;
}

type MarkdownNode = {
  type: string;
  url?: string;
  identifier?: string;
  children?: MarkdownNode[];
};

function fileIdentity(path: string): string {
  // This is only presentation deduplication, never an authorization check.
  // localFilePath has already decoded file:// once, including literal #/?
  // characters in filenames. Only raw Markdown paths have suffixes to strip.
  if (/^file:\/\//i.test(path)) return localFilePath(path) ?? path;
  try { return decodeURIComponent(path.split(/[?#]/, 1)[0]!); }
  catch { return path; }
}

/** Real Markdown links only: prose, examples, images, and remote URLs don't
 * turn into host file cards. The server independently validates every click. */
export function collectMessageFiles(text: string, existingPaths: readonly string[] = []): GalleryFile[] {
  const tree: MarkdownNode = fromMarkdown(text, { mdastExtensions: [windowsPathDestinations] });
  const definitions = new Map<string, string>();
  const links: MarkdownNode[] = [];
  const pending = [tree];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.type === "definition" && node.identifier && node.url && !definitions.has(node.identifier)) {
      definitions.set(node.identifier, node.url);
    } else if (node.type === "link" || node.type === "linkReference") {
      // Linked images already have a thumbnail in the Markdown renderer.
      if (!node.children?.some((child) => child.type === "image" || child.type === "imageReference")) links.push(node);
    }
    if (node.children) pending.push(...[...node.children].reverse());
  }
  const seen = new Set(existingPaths.map(fileIdentity));
  return links.flatMap((node) => {
    const href = node.url ?? (node.identifier ? definitions.get(node.identifier) : undefined);
    const path = localFilePath(href);
    if (!path || !href) return [];
    const identity = fileIdentity(href);
    if (seen.has(identity)) return [];
    seen.add(identity);
    // Send the authored spelling, not the decoded display path: the server
    // owns the one decode at its authorization/file-opening boundary.
    return [{ path: href, name: safeDownloadFilename(attachmentBasename(identity)), linked: true }];
  });
}

export function isVideoAttachment(path: string): boolean {
  return /\.(?:mp4|m4v|webm|mov)$/i.test(fileIdentity(path));
}

const NO_GENERATED_ATTACHMENTS: readonly { path: string }[] = [];

/** Group/room rows can share the gallery without parsing every old message
 * on unrelated state updates. Preserve the message's original attachment array. */
export function MessageAttachmentGallery({ text, attachments = NO_GENERATED_ATTACHMENTS, message, eager, className, variant }: {
  text: string;
  attachments?: readonly { path: string }[];
  message: MessageAttachmentContext;
  eager?: boolean;
  className?: string;
  variant?: GalleryVariant;
}) {
  const images = useMemo(() => attachments.map((attachment) => attachment.path), [attachments]);
  const files = useMemo(() => collectMessageFiles(text, images), [text, images]);
  return <AttachmentGallery images={images} files={files} message={message} eager={eager} className={className} variant={variant} />;
}

/** A server-provided MIME is required as well as the filename hint. Old
 * servers can still download a video but never turn arbitrary bytes into UI. */
export async function loadMessageVideo(
  file: GalleryFile,
  message: MessageAttachmentContext,
  signal: AbortSignal,
): Promise<Blob> {
  const response = await requestMessageFile(file.path, message, signal);
  const mime = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (!mime || !["video/mp4", "video/webm", "video/quicktime", "video/x-m4v"].includes(mime)) {
    await response.body?.cancel();
    throw new Error(t("attach.videoUnavailable"));
  }
  const declared = Number(response.headers.get("content-length"));
  if (declared > FILE_MAX_BYTES) {
    await response.body?.cancel();
    throw new Error(t("attach.fileTooLarge"));
  }
  // Keep this bounded even if a reverse proxy omits Content-Length.
  const reader = response.body?.getReader();
  if (!reader) throw new Error(t("attach.videoUnavailable"));
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    for (;;) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > FILE_MAX_BYTES) throw new Error(t("attach.fileTooLarge"));
      chunks.push(new Uint8Array(value));
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return new Blob(chunks, { type: mime });
}

/** A row of images fits at natural aspect when their widths at the shared row
 * height, (width - 24) / 4, plus 8px gaps stay inside the row. Unknown
 * aspects count as squares. Without a measured width the 4-slot rule applies. */
export function imageRowFits(aspects: ReadonlyArray<number | null | undefined>, containerWidth?: number): boolean {
  const known = aspects.map((aspect) => aspect && Number.isFinite(aspect) && aspect > 0 ? aspect : 1);
  const total = known.reduce((sum, aspect) => sum + aspect, 0);
  if (!containerWidth || containerWidth <= 24) return total <= 4 + 1e-6;
  const rowHeight = (containerWidth - 24) / 4;
  return total * rowHeight + 8 * (known.length - 1) <= containerWidth + 0.5;
}

/** Keep a focused tile inside the 4-tile window. */
export function pagerOffsetFor(index: number, offset: number, count: number, visible = 4): number {
  const max = Math.max(0, count - visible);
  if (index < offset) return Math.max(0, index);
  if (index >= offset + visible) return Math.min(max, index - visible + 1);
  return Math.min(Math.max(0, offset), max);
}

function SingleImage({ image, eager, onPreview }: { image: PreviewImage; eager: boolean; onPreview: () => void }) {
  const [aspect, setAspect] = useState<number | null>(null);
  return (
    <div className={cn("w-full", singleImageMaxWidth(aspect))}>
      <AttachmentThumbnail
        key={image.src}
        image={image}
        eager={eager}
        onPreview={onPreview}
        onAspect={setAspect}
        style={aspect ? { aspectRatio: String(aspect) } : undefined}
        downloadable
      />
    </div>
  );
}

/** Two or more assistant images share one row height. If they fit at their
 * natural aspect they all show; otherwise they become square tiles, four at a
 * time, paged one tile per step. */
function ImageRow({ images, eager, onPreview }: { images: PreviewImage[]; eager: boolean; onPreview: (index: number) => void }) {
  const [aspects, setAspects] = useState<Record<string, number>>({});
  const [offset, setOffset] = useState(0);
  const fits = imageRowFits(images.map((image) => aspects[image.src]));
  const maxOffset = Math.max(0, images.length - 4);
  const current = Math.min(offset, maxOffset);
  const step = (direction: -1 | 1) => setOffset(Math.min(maxOffset, Math.max(0, current + direction)));
  const arrow = cn(
    "absolute top-1/2 z-10 flex size-6 -translate-y-1/2 items-center justify-center rounded-full transition-opacity duration-150 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 disabled:cursor-default disabled:text-white/45 disabled:hover:bg-black/45",
    MEDIA_OVERLAY_CONTROL,
    "opacity-0 group-hover/row:opacity-100 [@media(hover:none)]:opacity-100",
  );
  return (
    <div className="group/row relative w-full overflow-hidden" role="group" aria-label={t("attach.galleryCount", { count: images.length })}>
      <div
        className="flex w-full gap-2 transition-transform duration-300 ease-[cubic-bezier(.4,0,.2,1)] motion-reduce:transition-none"
        style={fits ? undefined : { transform: `translateX(calc(${-current} * ((100% - 24px) / 4 + 8px)))` }}
      >
        {images.map((image, index) => {
          const aspect = fits ? aspects[image.src] ?? 1 : 1;
          return (
            <div
              key={`${image.src}:${index}`}
              className="flex-none"
              style={{ width: `calc((100% - 24px) * ${aspect} / 4)` }}
              onFocus={() => { if (!fits) setOffset((value) => pagerOffsetFor(index, value, images.length)); }}
            >
              <AttachmentThumbnail
                key={image.src}
                image={image}
                eager={eager}
                onPreview={() => onPreview(index)}
                onAspect={(value) => setAspects((known) => known[image.src] === value ? known : { ...known, [image.src]: value })}
                style={{ aspectRatio: String(aspect) }}
                downloadable
              />
            </div>
          );
        })}
      </div>
      {!fits && images.length > 4 && (
        <>
          <button type="button" onClick={() => step(-1)} disabled={current === 0} aria-label={t("attach.previous")} className={cn(arrow, "start-2")}>
            <ChevronUp size={16} strokeWidth={1.2} absoluteStrokeWidth className="-rotate-90" />
          </button>
          <button type="button" onClick={() => step(1)} disabled={current >= maxOffset} aria-label={t("attach.next")} className={cn(arrow, "end-2")}>
            <ChevronUp size={16} strokeWidth={1.2} absoluteStrokeWidth className="rotate-90" />
          </button>
          <span className="pointer-events-none absolute end-2 bottom-2 inline-flex h-6 items-center gap-0.5 rounded-full bg-black/45 ps-1.5 pe-2 text-[12px] leading-none font-medium text-white tabular-nums shadow-sm transition-opacity duration-150 group-hover/row:opacity-0">
            <Images size={14} aria-hidden="true" />
            {images.length}
          </span>
        </>
      )}
    </div>
  );
}

function VideoAttachment({ file, message, variant }: { file: GalleryFile; message: MessageAttachmentContext; variant: GalleryVariant }) {
  const [preview, setPreview] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(false);
  const request = useRef<AbortController | null>(null);
  const playButton = useRef<HTMLButtonElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    if (preview) videoRef.current?.focus();
    return () => { if (preview) URL.revokeObjectURL(preview); };
  }, [preview]);

  const load = async () => {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError("");
    setPreview(null);
    try {
      const blob = await loadMessageVideo(file, message, controller.signal);
      if (!controller.signal.aborted) setPreview(URL.createObjectURL(blob));
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : t("attach.videoUnavailable"));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
      if (request.current === controller) request.current = null;
    }
  };
  const close = () => {
    request.current?.abort();
    request.current = null;
    setLoading(false);
    setExpanded(false);
    setPreview(null);
    setError("");
    // The button is hidden while the preview is mounted.
    requestAnimationFrame(() => playButton.current?.focus());
  };
  const expand = () => {
    videoRef.current?.pause();
    setExpanded(true);
  };

  return (
    <div className={cn("group/resource-card w-[320px] max-w-full shrink-0 overflow-hidden rounded-[20px] bg-raised", MEDIA_RING)}>
      <div className="group/video relative flex aspect-video items-center justify-center bg-black">
        {preview && !error ? (
          <video
            ref={videoRef}
            src={preview}
            tabIndex={0}
            controls
            playsInline
            preload="metadata"
            aria-label={t("attach.previewVideo", { name: file.name })}
            className="size-full object-contain"
            onError={() => setError(t("attach.videoUnavailable"))}
          />
        ) : (
          <button
            ref={playButton}
            type="button"
            disabled={loading}
            onClick={() => void load()}
            aria-label={t("attach.previewVideo", { name: file.name })}
            className="group/play flex size-full flex-col items-center justify-center gap-2 p-3 text-center text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/60 disabled:cursor-wait"
          >
            <span className={cn("flex size-12 items-center justify-center rounded-full backdrop-blur-sm transition-colors", MEDIA_OVERLAY_CONTROL, "group-hover/play:bg-black/60")}>
              {loading ? <LoaderCircle size={20} className="animate-spin" /> : error ? <RotateCcw size={18} /> : <Play size={20} className="translate-x-px" fill="currentColor" />}
            </span>
            <span className="text-[12px] leading-4 font-medium text-white/85">{loading ? t("attach.videoLoading") : error ? t("chat.retry") : t("attach.loadVideo")}</span>
            {!error && !loading && <span className="text-[11px] leading-4 text-white/55">{t("attach.videoHint")}</span>}
          </button>
        )}
        {(preview || loading || error) && (
          <div className="absolute end-2 top-2 flex items-center gap-1.5">
            {preview && !error && (
              <button type="button" aria-label={t("attach.previewVideo", { name: file.name })} title="Expand" onClick={expand} className={cn("flex size-7 items-center justify-center rounded-full backdrop-blur-sm transition-opacity focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70", MEDIA_OVERLAY_CONTROL, "opacity-0 group-hover/video:opacity-100 [@media(hover:none)]:opacity-100")}>
                <Maximize2 size={14} />
              </button>
            )}
            <button type="button" aria-label={t("attach.closeVideo")} onClick={close} className={cn("flex size-7 items-center justify-center rounded-full backdrop-blur-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70", MEDIA_OVERLAY_CONTROL)}>
              <X size={14} />
            </button>
          </div>
        )}
      </div>
      {error && <p role="alert" className="px-3 pt-2 text-[12px] leading-4 text-danger">{error}</p>}
      <AttachedFileChip file={file} linked={file.linked} message={message} variant={variant === "user" ? "user" : "tile"} className="w-full rounded-none bg-transparent ring-0" />
      {expanded && preview && (
        <MediaLightbox
          label={t("attach.previewVideo", { name: file.name })}
          title={file.name}
          closeLabel="Close video player"
          onClose={() => setExpanded(false)}
        >
          <video src={preview} controls autoPlay playsInline aria-label="Video player" className="block max-h-full max-w-full rounded-[10px] bg-black object-contain" />
        </MediaLightbox>
      )}
    </div>
  );
}

type GalleryItem = { key: string } & (
  | { kind: "image"; image: PreviewImage }
  | { kind: "video" | "audio" | "file"; file: GalleryFile }
);

/** `user`: a person's uploads, right-aligned and meant to sit above the
 * bubble. `assistant`: generated images and linked files in a reply. */
export type GalleryVariant = "user" | "assistant";

export function AttachmentGallery({ images = [], files = [], message, eager = false, className, variant = "assistant" }: {
  images?: Array<string | TranscriptImageAttachment>;
  files?: GalleryFile[];
  message?: MessageAttachmentContext;
  eager?: boolean;
  className?: string;
  variant?: GalleryVariant;
}) {
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState<PreviewImage | null>(null);
  const items = useMemo(() => {
    const seen = new Set<string>();
    const result: GalleryItem[] = [];
    for (const reference of images) {
      const path = typeof reference === "string" ? reference : reference.path;
      const key = fileIdentity(path);
      if (seen.has(key)) continue;
      seen.add(key);
      const image = typeof reference === "string" || reference.private
        ? previewImage(path, typeof reference === "string" ? undefined : reference.name, message)
        : null;
      if (image) result.push({ key, kind: "image", image });
      else result.push({ key, kind: "file", file: typeof reference === "string" ? { path, name: attachmentBasename(path) } : reference });
    }
    for (const file of files) {
      const key = fileIdentity(file.path);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ key, kind: message && (file.private || file.linked) && isAudioFilename(file.name) ? "audio" : message && (file.private || file.linked) && isVideoAttachment(file.path) ? "video" : "file", file });
    }
    return result;
  }, [images, files, message]);
  if (!items.length) return null;
  const user = variant === "user";
  const imageItems = items.flatMap((item) => item.kind === "image" ? [item] : []);
  const previews = imageItems.map((item) => item.image);
  const others = items.filter((item) => item.kind !== "image");
  // Images page (assistant) or wrap (user); the rest collapse so the whole
  // collection starts at four visible items.
  const budget = Math.max(1, 4 - imageItems.length);
  const shownOthers = expanded ? others : others.slice(0, budget);
  const hidden = others.length - shownOthers.length;
  const media = shownOthers.filter((item) => item.kind === "audio" || item.kind === "video");
  const documents = shownOthers.filter((item) => item.kind === "file");
  const openImage = (image: PreviewImage) => setSelected(image);

  return (
    <section
      aria-label={items.length === 1 ? t("attach.gallerySingle") : t("attach.galleryCount", { count: items.length })}
      className={cn(
        "flex max-w-full flex-col gap-2 whitespace-normal",
        user ? "mb-2 w-full items-end self-end text-left" : "mb-3 w-full items-start text-left",
        className,
      )}
    >
      <MediaKeyframes />
      {imageItems.length > 0 && (user ? (
        <div className="flex max-w-full flex-wrap items-end justify-end gap-2">
          {imageItems.map((item) => (
            <AttachmentThumbnail key={item.image.src} image={item.image} variant="user" eager={eager} onPreview={() => openImage(item.image)} />
          ))}
        </div>
      ) : imageItems.length === 1 ? (
        <SingleImage image={imageItems[0].image} eager={eager} onPreview={() => openImage(imageItems[0].image)} />
      ) : (
        <ImageRow images={previews} eager={eager} onPreview={(index) => openImage(previews[index])} />
      ))}
      {media.length > 0 && (
        <div className={cn("flex max-w-full flex-wrap gap-2", user && "justify-end")}>
          {media.map((item) => item.kind === "audio" && message ? (
            <AudioAttachment key={`${message.threadId}:${message.messageId}:${item.key}`} file={item.file} transcriptFile={matchingTranscript(item.file, files)} message={message} />
          ) : item.kind === "video" && message ? (
            <VideoAttachment key={`${message.threadId}:${message.messageId}:${item.key}`} file={item.file} message={message} variant={variant} />
          ) : null)}
        </div>
      )}
      {documents.length > 0 && (
        <div className={cn("flex max-w-full flex-wrap gap-2", user ? "w-full justify-end md:w-4/5" : "")}>
          {documents.map((item) => item.kind === "file" && (
            <AttachedFileChip key={item.key} file={item.file} linked={item.file.linked} message={message} variant={user ? "user" : "tile"} />
          ))}
        </div>
      )}
      {(hidden > 0 || expanded) && others.length > budget && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          className={cn("flex h-10 items-center justify-center gap-1 rounded-[10px] px-3 text-[14px] transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60", MEDIA_TEXT_TERTIARY)}
        >
          {expanded ? <ChevronUp size={16} aria-hidden="true" /> : <ChevronDown size={16} aria-hidden="true" />}
          {expanded ? t("attach.showLess") : t("attach.showMore", { count: hidden })}
        </button>
      )}
      {selected && previews.some((image) => image.src === selected.src) && (
        <AttachmentPreviewDialog image={selected} images={previews} initialIndex={previews.findIndex((image) => image.src === selected.src)} onClose={() => setSelected(null)} />
      )}
    </section>
  );
}
