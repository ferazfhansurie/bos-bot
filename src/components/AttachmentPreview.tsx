// Same-origin attachment previews plus the reusable image viewer used by
// Markdown. Transcript paths are resolved through attachmentImageUrl; model
// text never gets to turn an arbitrary local path into a browser request.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  ImageOff,
  LoaderCircle,
  RotateCcw,
  X,
} from "lucide-react";

import {
  attachmentBasename,
  attachmentImageUrl,
  type TranscriptFileAttachment,
  type TranscriptImageAttachment,
} from "@/lib/composer-attachments";
import { cn } from "@/lib/cn";
import { ZoomableImage } from "./ZoomableImage";
import { t } from "@/lib/i18n";
import {
  FileKindIcon,
  fileTypeLabel,
  MEDIA_BORDER,
  MEDIA_BORDER_STRONG,
  MEDIA_ENTER,
  MEDIA_OVERLAY_CONTROL,
  MEDIA_PLACEHOLDER,
  MEDIA_RING,
  MEDIA_TEXT_SECONDARY,
  MEDIA_TEXT_TERTIARY,
  MediaKeyframes,
} from "./MediaTokens";

export interface PreviewImage {
  src: string;
  name: string;
  /** Same-origin images can be downloaded directly. */
  downloadUrl?: string;
  /** A portable filename chosen independently from the visible label. */
  downloadName?: string;
  /** Authored remote images keep an explicit way to open their source. */
  openUrl?: string;
}

export interface MessageAttachmentContext { threadId: string; messageId: string; remoteRoom?: boolean }

export function previewImage(path: string, name = attachmentBasename(path), message?: MessageAttachmentContext): PreviewImage | null {
  const ordinary = attachmentImageUrl(path);
  const src = ordinary && message?.remoteRoom
    ? `/api/threads/${encodeURIComponent(message.threadId)}/messages/${encodeURIComponent(message.messageId)}/file?attachment=${encodeURIComponent(path)}`
    : ordinary;
  if (!src) return null;
  return {
    src,
    name,
    downloadUrl: src,
    downloadName: canonicalDownloadFilename({ fallback: name, source: path }),
  };
}

export function wrappedImageIndex(index: number, step: -1 | 1, count: number): number {
  if (count <= 0) return 0;
  return (index + step + count) % count;
}

export type PreviewKeyAction = "close" | "previous" | "next" | null;

export function previewKeyAction(key: string, count: number): PreviewKeyAction {
  if (key === "Escape") return "close";
  if (count > 1 && key === "ArrowLeft") return "previous";
  if (count > 1 && key === "ArrowRight") return "next";
  return null;
}

export function imageGalleryLayout(count: number): string {
  if (count <= 1) return "w-[min(32rem,70vw)] grid-cols-1";
  if (count === 2) return "w-[min(36rem,70vw)] grid-cols-2";
  return "w-[min(38rem,70vw)] grid-cols-2 sm:grid-cols-3";
}

const IMAGE_EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/gif": "gif",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/tiff": "tiff",
  "image/webp": "webp",
};

const IMAGE_EXTENSIONS = new Set([
  "avif",
  "bmp",
  "gif",
  "heic",
  "heif",
  "jpeg",
  "jpg",
  "png",
  "tif",
  "tiff",
  "webp",
]);

/** Keep a suggested download name portable and prevent it from naming a path. */
export function safeDownloadFilename(value: string | null | undefined): string {
  const basename = (value ?? "").split(/[\\/]/).at(-1) ?? "";
  const cleaned = basename
    .normalize("NFC")
    // oxlint-disable-next-line no-control-regex -- strips control and bidi characters from a filename
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/[<>:"|?*]/g, "_")
    .trim()
    .replace(/[. ]+$/g, "");
  const bounded = Array.from(cleaned)
    .filter((character) => {
      const code = character.charCodeAt(0);
      return character.length > 1 || code < 0xd800 || code > 0xdfff;
    })
    .slice(0, 180)
    .join("");
  if (!bounded) return "download";
  const stem = bounded.split(".", 1)[0]!.toUpperCase();
  return /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem) ? `_${bounded}` : bounded;
}

/** Read the server-selected filename, preferring RFC 5987's UTF-8 form. */
export function contentDispositionFilename(header: string | null): string | null {
  if (!header) return null;
  const encoded = /(?:^|;)\s*filename\*\s*=\s*(?:UTF-8'[^']*')?([^;]*)/i.exec(header)?.[1]?.trim();
  if (encoded) {
    const unquoted = encoded.replace(/^"|"$/g, "");
    try {
      return safeDownloadFilename(decodeURIComponent(unquoted));
    } catch {
      // A malformed extended value may still have a valid ASCII fallback.
    }
  }
  const quoted = /(?:^|;)\s*filename\s*=\s*"((?:\\.|[^"\\])*)"/i.exec(header)?.[1];
  if (quoted !== undefined) return safeDownloadFilename(quoted.replace(/\\(.)/g, "$1"));
  const plain = /(?:^|;)\s*filename\s*=\s*([^;]*)/i.exec(header)?.[1]?.trim();
  return plain ? safeDownloadFilename(plain) : null;
}

function sourceImageExtension(source: string | undefined): string | null {
  if (!source) return null;
  let pathname = source;
  try {
    pathname = decodeURIComponent(new URL(source, "https://bosbot.invalid").pathname);
  } catch {
    pathname = source.split(/[?#]/, 1)[0] ?? source;
  }
  const extension = /\.([a-z0-9]+)$/i.exec(pathname)?.[1]?.toLowerCase();
  return extension && IMAGE_EXTENSIONS.has(extension) ? extension : null;
}

function replaceExtension(name: string, extension: string): string {
  const suffix = `.${extension}`;
  const stem = name.replace(/\.[^.]*$/, "") || "image";
  const available = Math.max(1, 180 - Array.from(suffix).length);
  return `${Array.from(stem).slice(0, available).join("")}${suffix}`;
}

/** The response chooses the label; image bytes/source choose the extension. */
export function canonicalDownloadFilename({
  contentDisposition,
  fallback,
  source,
  mime,
}: {
  contentDisposition?: string | null;
  fallback?: string;
  source?: string;
  mime?: string | null;
}): string {
  const selected = contentDispositionFilename(contentDisposition ?? null)
    ?? safeDownloadFilename(fallback);
  const mediaType = mime?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const imageExtension = IMAGE_EXTENSION_BY_MIME[mediaType] ?? sourceImageExtension(source);
  return imageExtension ? replaceExtension(selected, imageExtension) : selected;
}

export function isExternalImageSource(src: string): boolean {
  const value = src.trim();
  // The URL parser removes embedded ASCII tab/LF/CR and treats backslashes as
  // slashes for special schemes. Normalize those parser quirks before deciding
  // whether mounting the image would make a network request.
  const networkSpelling = value.replace(/[\t\n\r]/g, "").replace(/\\/g, "/");
  // Chromium canonicalizes special-scheme variants such as `https:host/x`,
  // `https:/host/x`, and backslash spellings into network requests. Treat the
  // whole scheme family as remote before an <img> can mount.
  return networkSpelling.startsWith("//") || /^https?:/i.test(networkSpelling);
}

/** A message-scoped image URL is safe for an <img>: the server still proves
 * that this exact message rendered an image at this Markdown source offset
 * before streaming it. The host path never enters the browser URL. */
export function messageImagePreviewUrl(
  message: MessageAttachmentContext,
  sourceOffset: number,
): string {
  return `/api/threads/${encodeURIComponent(message.threadId)}/messages/${encodeURIComponent(message.messageId)}/file?preview=1&ref=${sourceOffset}`;
}

function revokeObjectUrlLater(url: string): void {
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Downloads and explicit media previews share the message-scoped capability.
 * Never request a transcript path directly, even when it looks like a URL. */
export async function requestMessageFile(
  filePath: string,
  message: MessageAttachmentContext,
  signal: AbortSignal,
): Promise<Response> {
  const response = await fetch(`/api/threads/${encodeURIComponent(message.threadId)}/messages/${encodeURIComponent(message.messageId)}/file`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: filePath }),
    signal,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error ?? t("attach.downloadFailed"));
  }
  return response;
}

/** Shared save state for transcript file chips and bot-authored file links. */
export function useLocalFileSave(filePath: string, name?: string, message?: MessageAttachmentContext) {
  const [state, setState] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const [reason, setReason] = useState("");
  const [savedTo, setSavedTo] = useState("");
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const request = useRef<AbortController | null>(null);
  const saving = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current?.abort();
      if (resetTimer.current) clearTimeout(resetTimer.current);
    };
  }, []);

  useEffect(() => {
    request.current?.abort();
    request.current = null;
    saving.current = false;
    setReason("");
    setSavedTo("");
    setState("idle");
  }, [filePath, message?.messageId, message?.threadId]);

  const save = useCallback(async () => {
    if (saving.current) return;
    if (!message) {
      setReason(t("attach.unavailableOld"));
      setState("failed");
      return;
    }
    saving.current = true;
    if (resetTimer.current) {
      clearTimeout(resetTimer.current);
      resetTimer.current = null;
    }
    setReason("");
    setState("saving");
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    try {
      const response = await requestMessageFile(filePath, message, controller.signal);
      const blob = await response.blob();
      if (!mounted.current || controller.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      const saved = canonicalDownloadFilename({
        contentDisposition: response.headers.get("content-disposition"),
        fallback: name || attachmentBasename(filePath),
        source: filePath,
        mime: blob.type || response.headers.get("content-type"),
      });
      try {
        const link = document.createElement("a");
        link.href = url;
        link.download = saved;
        link.style.display = "none";
        document.body.append(link);
        try {
          link.click();
        } finally {
          link.remove();
        }
      } finally {
        // Chromium may not consume a blob URL until after the click task ends.
        revokeObjectUrlLater(url);
      }
      if (!mounted.current || controller.signal.aborted) return;
      setSavedTo(saved);
      setState("saved");
      if (resetTimer.current) clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => {
        if (mounted.current) setState("idle");
      }, 4000);
    } catch (error) {
      if (!mounted.current || controller.signal.aborted) return;
      setReason(error instanceof Error ? error.message : t("attach.saveFailed"));
      setState("failed");
    } finally {
      if (request.current === controller) {
        request.current = null;
        saving.current = false;
      }
    }
  }, [filePath, message?.messageId, message?.threadId, name]);

  return { state, reason, savedTo, save };
}


/** Frosted round control used on the black media viewer. */
export const LIGHTBOX_BUTTON = "flex size-9 shrink-0 items-center justify-center rounded-full bg-white/[0.12] text-white backdrop-blur-md transition-colors hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 disabled:text-white/45 disabled:hover:bg-white/[0.12]";

/** Full-window black viewer shared by images and videos: a header with the
 * title and frosted actions, centred media, previous/next, Escape to close,
 * arrow keys to page, and a focus trap that returns focus on close. */
export function MediaLightbox({
  label,
  title,
  subtitle,
  actions,
  count = 1,
  onNavigate,
  onClose,
  closeLabel = t("attach.close"),
  previousLabel = t("attach.previous"),
  nextLabel = t("attach.next"),
  children,
}: {
  label: string;
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  count?: number;
  onNavigate?: (step: -1 | 1) => void;
  onClose: () => void;
  closeLabel?: string;
  previousLabel?: string;
  nextLabel?: string;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const navigateRef = useRef(onNavigate);
  useLayoutEffect(() => {
    closeRef.current = onClose;
    navigateRef.current = onNavigate;
  }, [onClose, onNavigate]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      const action = previewKeyAction(event.key, navigateRef.current ? count : 1);
      if (action) {
        event.preventDefault();
        event.stopPropagation();
        if (action === "close") closeRef.current();
        else navigateRef.current?.(action === "previous" ? -1 : 1);
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], video[controls], [tabindex]:not([tabindex="-1"])',
      )];
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === dialog || document.activeElement === first)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previousFocus?.focus();
    };
  }, [count]);

  return createPortal(
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      tabIndex={-1}
      className="fixed inset-0 z-[70] flex flex-col bg-[#0d0d0d] text-white outline-none"
    >
      <MediaKeyframes />
      <header className="relative z-10 flex h-14 shrink-0 items-center justify-between gap-4 ps-5 pe-3">
        <div className="min-w-0">
          <div className="truncate text-[13px] leading-[18px] font-medium text-white">{title}</div>
          {subtitle && <div className="text-[12px] leading-4 text-white/60 tabular-nums">{subtitle}</div>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {actions}
          <button type="button" onClick={onClose} className={LIGHTBOX_BUTTON} aria-label={closeLabel} title={closeLabel}>
            <X size={18} />
          </button>
        </div>
      </header>
      <div
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden px-16 pt-2 pb-14"
        onMouseDown={(event) => event.target === event.currentTarget && onClose()}
      >
        {children}
        {count > 1 && onNavigate && (
          <>
            <button type="button" onClick={() => onNavigate(-1)} aria-label={previousLabel} className={cn(LIGHTBOX_BUTTON, "absolute start-4 top-1/2 -translate-y-1/2")}>
              <ChevronLeft size={20} />
            </button>
            <button type="button" onClick={() => onNavigate(1)} aria-label={nextLabel} className={cn(LIGHTBOX_BUTTON, "absolute end-4 top-1/2 -translate-y-1/2")}>
              <ChevronRight size={20} />
            </button>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

export function AttachmentPreviewDialog({
  image,
  images,
  initialIndex = 0,
  onClose,
}: {
  image: PreviewImage;
  images?: PreviewImage[];
  initialIndex?: number;
  onClose: () => void;
}) {
  const items = images?.length ? images : [image];
  const [index, setIndex] = useState(() => Math.min(Math.max(initialIndex, 0), items.length - 1));
  const current = items[index] ?? image;
  const [loadedSources, setLoadedSources] = useState<Set<string>>(() => new Set());
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const navigate = useCallback((step: -1 | 1) => {
    setIndex((value) => wrappedImageIndex(value, step, items.length));
    setFailedSource(null);
  }, [items.length]);

  const loaded = loadedSources.has(current.src);
  const failed = failedSource === current.src;
  const retry = () => {
    setFailedSource(null);
    setLoadedSources((sources) => {
      const next = new Set(sources);
      next.delete(current.src);
      return next;
    });
    setAttempt((value) => value + 1);
  };

  return (
    <MediaLightbox
      label={t("attach.previewAria", { name: current.name })}
      title={current.name}
      subtitle={items.length > 1 ? t("attach.position", { index: index + 1, count: items.length }) : undefined}
      count={items.length}
      onNavigate={items.length > 1 ? navigate : undefined}
      onClose={onClose}
      actions={(
        <>
          {current.openUrl && (
            <a
              href={current.openUrl}
              target="_blank"
              rel="noreferrer"
              className={LIGHTBOX_BUTTON}
              aria-label={t("attach.openOriginalAria", { name: current.name })}
              title={t("attach.openOriginal")}
            >
              <ExternalLink size={17} />
            </a>
          )}
          {current.downloadUrl && (
            <a
              href={current.downloadUrl}
              download={current.downloadName ?? canonicalDownloadFilename({
                fallback: current.name,
                source: current.downloadUrl,
              })}
              className={LIGHTBOX_BUTTON}
              aria-label={t("attach.downloadAria", { name: current.name })}
              title={t("attach.download")}
            >
              <Download size={17} />
            </a>
          )}
        </>
      )}
    >
      {!loaded && !failed && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center" role="status">
          <LoaderCircle size={20} className="animate-spin text-white/55" />
          <span className="sr-only">Loading {current.name}</span>
        </div>
      )}
      {failed ? (
        <div className="flex flex-col items-center gap-3 text-white/60" role="alert">
          <ImageOff size={28} />
          <span className="text-[13px]">Couldn&apos;t load this image</span>
          <button
            type="button"
            onClick={retry}
            className="flex h-7 items-center gap-1.5 rounded-full bg-white/[0.12] px-3 text-[12px] font-medium text-white hover:bg-white/20"
          >
            <RotateCcw size={13} /> Try again
          </button>
        </div>
      ) : (
        <ZoomableImage
          key={`${current.src}:${attempt}`}
          src={current.src}
          alt={current.name}
          ready={loaded}
          onLoad={() => setLoadedSources((sources) => new Set(sources).add(current.src))}
          onError={() => setFailedSource(current.src)}
          className={cn(
            "block max-h-full max-w-full object-contain select-none transition-opacity duration-150",
            loaded ? cn("opacity-100", MEDIA_ENTER) : "opacity-0",
          )}
        />
      )}
    </MediaLightbox>
  );
}

/** Width cap for a lone image, from its natural aspect (width / height). */
export function singleImageMaxWidth(aspect: number | null | undefined): string {
  if (!aspect || !Number.isFinite(aspect)) return "max-w-[30rem]";
  if (aspect < 1) return "max-w-[25rem]";
  if (aspect < 2) return "max-w-[30rem]";
  return "max-w-full";
}

export type ThumbnailVariant = "tile" | "user";

export function AttachmentThumbnail({
  image,
  onPreview,
  className,
  eager = false,
  variant = "tile",
  style,
  onAspect,
  downloadable = false,
}: {
  image: PreviewImage;
  onPreview: () => void;
  className?: string;
  eager?: boolean;
  /** `user`: an 80px square above a person's message. `tile`: assistant media. */
  variant?: ThumbnailVariant;
  style?: CSSProperties;
  /** Reports the natural width/height once pixels arrive. */
  onAspect?: (aspect: number) => void;
  /** Shows a hover download action when the image has a download URL. */
  downloadable?: boolean;
}) {
  // Every caller keys this component by src. Resetting in an effect races a
  // cached/blob image's onLoad: it can become ready before the effect runs,
  // then be put back into a permanent loading state.
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const [attempt, setAttempt] = useState(0);
  const user = variant === "user";
  const retry = (event: SyntheticEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setState("loading");
    setAttempt((value) => value + 1);
  };
  const retryKey = (event: ReactKeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") retry(event);
  };

  if (user && state === "failed") {
    return (
      <span role="alert" className={cn("flex size-16 shrink-0 items-center justify-center rounded-[12.5px] border border-danger/20 bg-danger/[0.08] px-1 text-center text-[10px] leading-3 text-danger", className)}>
        <span
          role="button"
          tabIndex={0}
          onClick={retry}
          onKeyDown={retryKey}
          className="cursor-pointer rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/50"
          aria-label={t("attach.retryAria", { name: image.name })}
          title={t("attach.retryAria", { name: image.name })}
        >
          Failed
        </span>
      </span>
    );
  }

  return (
    <span
      style={style}
      className={cn(
        "group/image relative block min-w-0 overflow-hidden",
        user
          ? cn("size-20 shrink-0 rounded-[12.5px] border", MEDIA_BORDER_STRONG)
          : "aspect-[4/3] rounded-[16px]",
        className,
      )}
    >
      {state === "loading" && (
        <span
          className={cn("absolute inset-0 flex items-center justify-center", !user && MEDIA_PLACEHOLDER)}
          role="status"
        >
          {user && <LoaderCircle size={16} className={cn("animate-spin", MEDIA_TEXT_TERTIARY)} />}
          <span className="sr-only">Loading {image.name}</span>
        </span>
      )}
      {state === "failed" ? (
        <span className={cn("absolute inset-0 flex flex-col items-center justify-center gap-2 bg-[color-mix(in_srgb,var(--color-ink)_5%,transparent)] px-3 text-center", MEDIA_TEXT_SECONDARY)} role="alert">
          <ImageOff size={20} aria-hidden="true" />
          <span className="max-w-full truncate text-[13px]">Couldn&apos;t load this image</span>
          <span
            role="button"
            tabIndex={0}
            onClick={retry}
            onKeyDown={retryKey}
            className={cn("flex h-7 cursor-pointer items-center gap-1 rounded-[12.5px] border px-2.5 text-[12px] text-ink transition-colors hover:bg-[color-mix(in_srgb,var(--color-ink)_7.8%,transparent)]", MEDIA_BORDER_STRONG)}
            aria-label={t("attach.retryAria", { name: image.name })}
          >
            <RotateCcw size={12} aria-hidden="true" /> Try again
          </span>
        </span>
      ) : (
        <span
          role="button"
          tabIndex={state === "ready" ? 0 : -1}
          aria-disabled={state !== "ready"}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (state === "ready") onPreview();
          }}
          onKeyDown={(event) => {
            if (state === "ready" && (event.key === "Enter" || event.key === " ")) {
              event.preventDefault();
              onPreview();
            }
          }}
          className="absolute inset-0 block size-full cursor-pointer text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60 aria-disabled:cursor-default"
          aria-label={t("attach.previewImageAria", { name: image.name })}
          title={t("attach.previewAria", { name: image.name })}
        >
          <img
            key={`${image.src}:${attempt}`}
            src={image.src}
            alt={image.name}
            referrerPolicy="no-referrer"
            draggable={false}
            loading={eager ? "eager" : "lazy"}
            fetchPriority={eager ? "high" : undefined}
            onLoad={(event) => {
              setState("ready");
              const { naturalWidth, naturalHeight } = event.currentTarget;
              if (onAspect && naturalWidth > 0 && naturalHeight > 0) onAspect(naturalWidth / naturalHeight);
            }}
            onError={() => setState("failed")}
            className={cn(
              "block size-full object-cover",
              user && "rounded-[10px]",
              state === "ready" ? cn("opacity-100", !user && MEDIA_ENTER) : "opacity-0",
            )}
          />
          {!user && state === "ready" && (
            <span className="pointer-events-none absolute inset-x-0 bottom-0 h-20 rounded-b-[16px] bg-linear-to-b from-transparent to-black/30 opacity-0 transition-opacity duration-150 group-hover/image:opacity-100 group-focus-within/image:opacity-100" />
          )}
        </span>
      )}
      {!user && downloadable && state === "ready" && image.downloadUrl && (
        <a
          href={image.downloadUrl}
          download={image.downloadName ?? canonicalDownloadFilename({ fallback: image.name, source: image.downloadUrl })}
          onClick={(event) => event.stopPropagation()}
          className={cn(
            "absolute end-3 top-3 z-10 flex size-8 items-center justify-center rounded-full backdrop-blur-sm transition-opacity duration-150 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70",
            MEDIA_OVERLAY_CONTROL,
            "opacity-0 group-hover/image:opacity-100 group-focus-within/image:opacity-100 [@media(hover:none)]:opacity-100",
          )}
          aria-label={t("attach.downloadAria", { name: image.name })}
          title={t("attach.download")}
        >
          <Download size={16} />
        </a>
      )}
    </span>
  );
}

/** A person's attached images: 80px squares, right-aligned above the bubble. */
export function AttachedImageGallery({
  paths,
  className,
  eager = false,
}: {
  paths: Array<string | TranscriptImageAttachment>;
  className?: string;
  eager?: boolean;
}) {
  const images = useMemo(() => paths.flatMap((reference) => {
    if (typeof reference !== "string" && !reference.private) return [];
    const path = typeof reference === "string" ? reference : reference.path;
    const name = typeof reference === "string" ? undefined : reference.name;
    const image = previewImage(path, name);
    return image ? [image] : [];
  }), [paths]);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  if (images.length === 0) return null;
  return (
    <>
      <div className={cn("mb-2 flex max-w-full flex-wrap items-end justify-end gap-2 self-end", className)}>
        {images.map((image, index) => (
          <AttachmentThumbnail key={`${image.src}:${index}`} image={image} variant="user" onPreview={() => setSelectedIndex(index)} eager={eager} />
        ))}
      </div>
      {selectedIndex !== null && images[selectedIndex] && (
        <AttachmentPreviewDialog
          image={images[selectedIndex]}
          images={images}
          initialIndex={selectedIndex}
          onClose={() => setSelectedIndex(null)}
        />
      )}
    </>
  );
}

const MEDIA_NOTICE = cn(
  "flex aspect-[4/3] w-full flex-col items-center justify-center gap-2 rounded-[16px] bg-[color-mix(in_srgb,var(--color-ink)_5%,transparent)] px-4 text-center text-[13px]",
  MEDIA_TEXT_SECONDARY,
);

/** A Markdown image keeps its remote source, but receives the same stable
 * loading/error surface and full-screen viewer as an attached image. */
export function MarkdownImagePreview({
  src,
  name,
  openUrl,
  message,
  filePath,
  sourceOffset,
}: {
  src: string;
  name: string;
  openUrl?: string;
  message?: MessageAttachmentContext;
  filePath?: string;
  sourceOffset?: number;
}) {
  const [open, setOpen] = useState(false);
  const [aspect, setAspect] = useState<number | null>(null);
  const containerRef = useRef<HTMLSpanElement>(null);
  const threadId = message?.threadId;
  const messageId = message?.messageId;
  const localSourceOffset = typeof sourceOffset === "number" && Number.isSafeInteger(sourceOffset) && sourceOffset >= 0
    ? sourceOffset
    : null;
  const localMessageImage = Boolean(
    filePath && threadId && messageId && localSourceOffset !== null,
  );
  const localImageKey = localMessageImage ? `${threadId}\u0000${messageId}\u0000${localSourceOffset}` : null;
  const [visibleLocalImageKey, setVisibleLocalImageKey] = useState<string | null>(null);
  const external = !filePath && isExternalImageSource(src);
  const [approvedExternalSource, setApprovedExternalSource] = useState<string | null>(null);

  useEffect(() => {
    if (!localImageKey) return;
    const element = containerRef.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      setVisibleLocalImageKey(localImageKey);
      return;
    }
    setVisibleLocalImageKey(null);
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return;
      setVisibleLocalImageKey(localImageKey);
      observer.disconnect();
    }, { rootMargin: "320px 0px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [localImageKey]);

  const shouldLoadLocalImage = localMessageImage && (visibleLocalImageKey === localImageKey || open);
  const externalAllowed = !external || approvedExternalSource === src;
  const visibleSource = externalAllowed
    ? localMessageImage
      ? shouldLoadLocalImage && filePath && threadId && messageId && localSourceOffset !== null
        ? messageImagePreviewUrl({ threadId, messageId }, localSourceOffset)
        : null
      : src
    : null;
  const image: PreviewImage = {
    src: visibleSource ?? "",
    name,
    openUrl,
    downloadUrl: localMessageImage ? visibleSource ?? undefined : undefined,
    downloadName: localMessageImage
      ? canonicalDownloadFilename({ fallback: name, source: filePath })
      : undefined,
  };
  return (
    <>
      <span ref={containerRef} className={cn("my-2 block w-full", singleImageMaxWidth(aspect))}>
        <MediaKeyframes />
        {external && !externalAllowed ? (
          <span className={MEDIA_NOTICE}>
            <ImageOff size={20} aria-hidden="true" />
            <span>{t("attach.externalHidden")}</span>
            <button
              type="button"
              className={cn("flex h-7 items-center rounded-[12.5px] border px-2.5 text-[12px] leading-[18px] text-ink transition-colors hover:bg-[color-mix(in_srgb,var(--color-ink)_7.8%,transparent)]", MEDIA_BORDER_STRONG)}
              onClick={(event) => { event.preventDefault(); event.stopPropagation(); setApprovedExternalSource(src); }}
            >
              {t("attach.loadImage")}
            </button>
          </span>
        ) : filePath && (!threadId || !messageId || localSourceOffset === null) ? (
          <span className={MEDIA_NOTICE} role="alert">
            <ImageOff size={20} aria-hidden="true" /> {t("attach.oldImage")}
          </span>
        ) : visibleSource ? (
          <AttachmentThumbnail
            key={image.src}
            image={image}
            onPreview={() => setOpen(true)}
            onAspect={setAspect}
            style={aspect ? { aspectRatio: String(aspect) } : undefined}
            downloadable
            eager
          />
        ) : (
          <span className={cn("block aspect-[4/3] w-full rounded-[16px]", MEDIA_PLACEHOLDER)} role="status">
            <span className="sr-only">Loading {name}</span>
          </span>
        )}
        {openUrl && (
          <a href={openUrl} target="_blank" rel="noreferrer" className={cn("mt-1.5 inline-flex items-center gap-1 text-[12px] hover:underline", MEDIA_TEXT_TERTIARY)}>
            <ExternalLink size={12} aria-hidden="true" /> {t("attach.openOriginal")}
          </a>
        )}
      </span>
      {open && visibleSource && <AttachmentPreviewDialog image={image} onClose={() => setOpen(false)} />}
    </>
  );
}

export type FileChipVariant = "tile" | "user";

/** ChatGPT's resource card. `tile` is an assistant file (320px, elevated, inset
 * ring); `user` is a thread attachment above a person's message (200px). */
export function AttachedFileChip({ file, message, linked = false, className, variant = "tile" }: {
  file: TranscriptFileAttachment;
  message?: MessageAttachmentContext;
  /** A rendered bot-authored Markdown link, still checked by the server on click. */
  linked?: boolean;
  className?: string;
  variant?: FileChipVariant;
}) {
  const save = useLocalFileSave(file.path, file.name, message);
  const failed = save.state === "failed";
  const user = variant === "user";
  const shell = cn(
    "group/resource-card relative max-w-full shrink-0 overflow-hidden rounded-[20px] bg-raised text-left",
    user ? "w-[200px]" : cn("w-[320px]", MEDIA_RING),
    className,
  );
  const header = cn("flex w-full items-center text-left", user ? "gap-2.5 p-1.5 pe-10" : "gap-2 p-2.5 pe-10");
  const body = (subtitle: string) => (
    <>
      <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-[12.5px] bg-inset", MEDIA_TEXT_SECONDARY)}>
        <FileKindIcon name={file.name} size={20} />
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn("block truncate text-ink", user ? "max-w-32 text-[14px] leading-5 font-medium" : "text-[12px] leading-[18px] font-semibold")}>{file.name}</span>
        <span className={cn("block truncate", MEDIA_TEXT_SECONDARY, user ? "text-[13px] leading-[18px]" : "text-[12px] leading-[18px]")}>{subtitle}</span>
      </span>
    </>
  );
  if (!message || (!file.private && !linked)) {
    return (
      <div title={t("attach.legacyFile", { name: file.name })} className={shell}>
        <div className={header}>{body(t("attach.unavailable"))}</div>
      </div>
    );
  }
  return (
    <div
      title={save.state === "saved" && save.savedTo ? t("attach.savedTo", { path: save.savedTo }) : file.name}
      className={shell}
    >
      <button
        type="button"
        onClick={() => void save.save()}
        disabled={save.state === "saving"}
        aria-label={
          failed
            ? t("attach.retrySaveAria", { name: file.name })
            : t("attach.saveAria", { name: file.name })
        }
        className={cn(header, "transition-colors hover:bg-[color-mix(in_srgb,var(--color-ink)_3%,transparent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60 disabled:cursor-wait")}
      >
        {body(fileTypeLabel(file.name))}
        <span
          className={cn(
            "pointer-events-none absolute end-3 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center",
            save.state === "idle"
              ? cn("opacity-0 transition-opacity group-hover/resource-card:opacity-100 group-focus-within/resource-card:opacity-100 [@media(hover:none)]:opacity-100", MEDIA_TEXT_SECONDARY)
              : save.state === "saved" ? "text-success" : save.state === "failed" ? "text-danger" : MEDIA_TEXT_SECONDARY,
          )}
          aria-hidden="true"
        >
          {save.state === "saving" ? (
            <LoaderCircle size={16} className="animate-spin" />
          ) : save.state === "saved" ? (
            <Check size={16} />
          ) : save.state === "failed" ? (
            <RotateCcw size={16} />
          ) : (
            <Download size={16} />
          )}
        </span>
      </button>
      {save.state !== "idle" && (
        <div
          role={failed ? "alert" : "status"}
          className={cn(
            "border-t px-3 py-1.5 text-[11px] leading-4",
            MEDIA_BORDER,
            failed ? "text-danger" : save.state === "saved" ? "text-success" : MEDIA_TEXT_SECONDARY,
          )}
        >
          {save.state === "saving"
            ? t("attach.downloading")
            : save.state === "saved"
              ? t("attach.downloaded")
              : save.reason}
        </div>
      )}
    </div>
  );
}

/** Transcript file paths stay inert until the person explicitly asks the
 * desktop shell to validate and save a copy. */
export function AttachedFileChips({ files, className, message, variant = "user" }: { files: TranscriptFileAttachment[]; className?: string; message?: MessageAttachmentContext; variant?: FileChipVariant }) {
  if (files.length === 0) return null;
  return (
    <div className={cn("mb-2 flex max-w-full flex-wrap justify-end gap-2 self-end", className)}>
      {files.map((file, index) => (
        <AttachedFileChip key={`${file.path}:${index}`} file={file} message={message} variant={variant} />
      ))}
    </div>
  );
}
