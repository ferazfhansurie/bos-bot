// Shared visual tokens for chat media (attachments, generated images, file
// tiles, artifacts). Every colour derives from the active skin's ink/surface
// variables so all skins inherit the same proportions; only the media viewer
// is fixed black, as on ChatGPT desktop.
import type { ComponentType } from "react";
import {
  File,
  FileArchive,
  FileAudio,
  FileCode2,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Presentation,
} from "lucide-react";

/** Hairline border (ink at 8.4%). */
export const MEDIA_BORDER = "border-[color-mix(in_srgb,var(--color-ink)_8.4%,transparent)]";
/** Strong border (ink at 15.6%). */
export const MEDIA_BORDER_STRONG = "border-[color-mix(in_srgb,var(--color-ink)_15.6%,transparent)]";
/** Inset 1px ring for elevated tiles. */
export const MEDIA_RING = "ring-1 ring-inset ring-[color-mix(in_srgb,var(--color-ink)_8.4%,transparent)]";
export const MEDIA_TEXT_SECONDARY = "text-[color-mix(in_srgb,var(--color-ink)_71%,transparent)]";
export const MEDIA_TEXT_TERTIARY = "text-[color-mix(in_srgb,var(--color-ink)_51%,transparent)]";
/** Image placeholder: a faint ink wash that pulses between .68 and .82. */
export const MEDIA_PLACEHOLDER = "bg-[color-mix(in_srgb,var(--color-ink)_6%,transparent)] animate-[bos-media-pulse_2.4s_ease-in-out_infinite] motion-reduce:animate-none motion-reduce:opacity-[.76]";
/** Image enter: .18s ease-out, scale .98 to 1. */
export const MEDIA_ENTER = "animate-[bos-media-enter_.18s_ease-out] motion-reduce:animate-none";
/** Overlay control on top of pixels (pager arrows, count chips). */
export const MEDIA_OVERLAY_CONTROL = "bg-black/45 text-white hover:bg-black/60";

const KEYFRAMES = "@keyframes bos-media-pulse{0%,100%{opacity:.68}50%{opacity:.82}}"
  + "@keyframes bos-media-enter{from{opacity:0;transform:scale(.98)}to{opacity:1;transform:scale(1)}}";

/** React 19 hoists and de-duplicates this by href, so every media surface can
 * render it without touching the global stylesheet. */
export function MediaKeyframes() {
  return <style href="bos-media-keyframes" precedence="default">{KEYFRAMES}</style>;
}

export type FileKind = "pdf" | "document" | "spreadsheet" | "presentation" | "archive" | "audio" | "video" | "image" | "code" | "text" | "file";

const KIND_BY_EXTENSION: Readonly<Record<string, FileKind>> = {
  pdf: "pdf",
  doc: "document", docx: "document", odt: "document", rtf: "document", pages: "document",
  xls: "spreadsheet", xlsx: "spreadsheet", ods: "spreadsheet", csv: "spreadsheet", tsv: "spreadsheet", numbers: "spreadsheet",
  ppt: "presentation", pptx: "presentation", odp: "presentation", key: "presentation",
  zip: "archive", gz: "archive", tgz: "archive", tar: "archive", rar: "archive", "7z": "archive", bz2: "archive", xz: "archive",
  mp3: "audio", m4a: "audio", wav: "audio", flac: "audio", ogg: "audio", opus: "audio", aac: "audio",
  mp4: "video", m4v: "video", mov: "video", webm: "video", mkv: "video", avi: "video",
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", avif: "image", heic: "image", heif: "image", bmp: "image", tif: "image", tiff: "image", svg: "image",
  js: "code", jsx: "code", ts: "code", tsx: "code", mjs: "code", cjs: "code", py: "code", rb: "code", go: "code", rs: "code", java: "code", kt: "code", swift: "code",
  c: "code", h: "code", cpp: "code", cs: "code", php: "code", sh: "code", zsh: "code", sql: "code", json: "code", yaml: "code", yml: "code", toml: "code", xml: "code", html: "code", css: "code",
  txt: "text", md: "text", markdown: "text", log: "text", vtt: "text", srt: "text",
};

const KIND_LABEL: Readonly<Record<Exclude<FileKind, "code" | "file">, string>> = {
  pdf: "PDF",
  document: "Document",
  spreadsheet: "Spreadsheet",
  presentation: "Presentation",
  archive: "Archive",
  audio: "Audio",
  video: "Video",
  image: "Image",
  text: "Text",
};

function extensionOf(name: string): string {
  return /\.([a-z0-9]{1,10})$/i.exec(name.trim())?.[1]?.toLowerCase() ?? "";
}

export function fileKind(name: string): FileKind {
  return KIND_BY_EXTENSION[extensionOf(name)] ?? "file";
}

/** The second line of a file tile: the file's type, as ChatGPT shows it. */
export function fileTypeLabel(name: string): string {
  const kind = fileKind(name);
  const extension = extensionOf(name);
  if (kind === "code") return extension.toUpperCase();
  if (kind === "file") return extension ? extension.toUpperCase() : "File";
  return KIND_LABEL[kind];
}

const KIND_ICON: Readonly<Record<FileKind, ComponentType<{ size?: number; className?: string; "aria-hidden"?: boolean | "true" }>>> = {
  pdf: FileText,
  document: FileText,
  spreadsheet: FileSpreadsheet,
  presentation: Presentation,
  archive: FileArchive,
  audio: FileAudio,
  video: FileVideo,
  image: FileImage,
  code: FileCode2,
  text: FileText,
  file: File,
};

export function FileKindIcon({ name, size = 20, className }: { name: string; size?: number; className?: string }) {
  const Icon = KIND_ICON[fileKind(name)];
  return <Icon size={size} className={className} aria-hidden="true" />;
}
