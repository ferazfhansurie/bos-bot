/** A file the bot linked in chat, shown right away in a large viewer over the
 * conversation: rendered by type (FilePreview), with open in files, open with
 * the default app, reveal and save a copy. Bytes come through the message's
 * file capability (any file the reply links inside the conversation's folder,
 * the bot's workspace or attachments, on desktop and web alike); an inline
 * `code` path, which that capability does not cover, reads through the
 * desktop's working folder api instead. */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Download, ExternalLink, FolderOpen, FolderTree, LoaderCircle, X } from "lucide-react";

import { contentDispositionFilename, requestMessageFile, type MessageAttachmentContext } from "@/components/AttachmentPreview";
import { FilePreview } from "@/components/FilePreview";
import { FileKindIcon } from "@/components/MediaTokens";
import { useWorkspace } from "@/components/workspace/WorkspaceContext";
import { openIn, openInAvailable } from "@/components/workspace/open-in";
import { cn } from "@/lib/cn";
import {
  baseName, formatSize, hasSource, isMediaKind, isTextKind, linkedFilePath, looksLikeText, mimeFor, previewKind, type PreviewKind,
} from "@/lib/file-preview";
import { RAW_PREVIEW, absolutePath, fetchRaw, readFile } from "@/lib/workspace-files-client";

const TEXT_MAX = 4 * 1024 * 1024;

interface Loaded { kind: PreviewKind; name: string; size?: number; url?: string; text?: string; truncated?: boolean; blob?: Blob }

const isAbsolute = (path: string) => path.startsWith("/") || /^[a-z]:[\\/]/i.test(path) || path.startsWith("\\\\");

async function fromBlob(blob: Blob, path: string, name: string): Promise<Loaded> {
  let kind = previewKind(path, blob.type);
  if (kind === "other" && looksLikeText(new Uint8Array(await blob.slice(0, 8192).arrayBuffer()))) kind = "text";
  if (isTextKind(kind)) {
    return { kind, name, size: blob.size, blob, text: await blob.slice(0, TEXT_MAX).text(), truncated: blob.size > TEXT_MAX };
  }
  if (isMediaKind(kind)) {
    // a pdf or video blob that came back as octet-stream renders as nothing
    const typed = mimeFor(path) && blob.type !== mimeFor(path) ? new Blob([blob], { type: mimeFor(path) }) : blob;
    return { kind, name, size: blob.size, blob, url: URL.createObjectURL(typed) };
  }
  return { kind: "other", name, size: blob.size, blob };
}

export default function FileViewerDialog({ path: href, message, threadId, onClose }: {
  path: string;
  /** The bot reply that links the file; absent for an inline `code` path. */
  message?: MessageAttachmentContext;
  threadId: string;
  onClose: () => void;
}) {
  const workspace = useWorkspace();
  // the request sends the link as written; everything shown or opened uses the file it names
  const path = message ? linkedFilePath(href) : href;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState("");
  const [source, setSource] = useState(false);
  const [inFolder, setInFolder] = useState(false);
  const [absolute, setAbsolute] = useState(isAbsolute(path) ? path : "");
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const controller = new AbortController();
    let url = "";
    const name = baseName(path);
    void (async () => {
      const location = await workspace.locate(path, threadId);
      if (controller.signal.aborted) return;
      setInFolder(location?.kind === "file");
      if (location && !isAbsolute(path)) setAbsolute(absolutePath(location.root, location.path));
      let result: Loaded;
      if (message) {
        const response = await requestMessageFile(href, message, controller.signal);
        const blob = await response.blob();
        result = await fromBlob(blob, path, contentDispositionFilename(response.headers.get("content-disposition")) ?? name);
      } else if (location?.kind === "file") {
        const where = location.target;
        const kind = previewKind(location.path);
        if (isMediaKind(kind) && RAW_PREVIEW.test(location.path)) {
          result = await fromBlob(await fetchRaw(where, location.path, controller.signal), location.path, name);
        } else {
          const file = await readFile(where, location.path, controller.signal);
          result = file.binary
            ? { kind: "other", name, size: file.size }
            : { kind: kind === "other" ? "text" : kind, name, size: file.size, text: file.content, truncated: file.truncated,
              blob: file.truncated ? undefined : new Blob([file.content], { type: "text/plain" }) };
        }
      } else {
        throw new Error("this file is outside the conversation's folder");
      }
      if (controller.signal.aborted) { if (result.url) URL.revokeObjectURL(result.url); return; }
      url = result.url ?? "";
      setLoaded(result);
    })().catch((cause) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message.toLowerCase() : "couldn't open this file");
    });
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [href, path, message?.threadId, message?.messageId, threadId]);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      closeRef.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => { window.removeEventListener("keydown", onKey, true); previous?.focus(); };
  }, []);

  const save = useCallback(() => {
    if (!loaded?.blob) return;
    const url = URL.createObjectURL(loaded.blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = loaded.name;
    link.style.display = "none";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }, [loaded]);

  const name = loaded?.name ?? baseName(path);
  const folder = path.slice(0, Math.max(0, path.length - baseName(path).length)).replace(/[\\/]$/, "");
  const native = openInAvailable() && Boolean(absolute);
  const button = "flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] text-ink-secondary hover:bg-raised hover:text-ink";
  const actions = (
    <>
      {inFolder && (
        <button type="button" className={button} title="show it in the files tab" onClick={() => { void workspace.openFile(path, threadId); onClose(); }}>
          <FolderTree size={15} /><span className="max-md:hidden">open in files</span>
        </button>
      )}
      {native && (
        <button type="button" className={button} title="open with default app" onClick={() => openIn(absolute, "default")}>
          <ExternalLink size={15} /><span className="max-md:hidden">open</span>
        </button>
      )}
      {native && (
        <button type="button" className={button} title={window.ogb?.platform === "darwin" ? "reveal in finder" : "show in folder"} onClick={() => openIn(absolute, "reveal")}>
          <FolderOpen size={15} /><span className="max-md:hidden">{window.ogb?.platform === "darwin" ? "finder" : "folder"}</span>
        </button>
      )}
      {loaded?.blob && (
        <button type="button" className={button} title="save a copy" onClick={save}>
          <Download size={15} /><span className="max-md:hidden">save</span>
        </button>
      )}
    </>
  );

  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/45 backdrop-blur-[2px] md:p-6"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={name} tabIndex={-1} data-testid="file-viewer"
        className="flex h-full w-full flex-col overflow-hidden bg-app shadow-2xl outline-none md:h-[min(92vh,1100px)] md:w-[min(1200px,96vw)] md:rounded-2xl md:border md:border-hairline/60">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-hairline/60 ps-4 pe-2">
          <FileKindIcon name={name} size={20} className="shrink-0 text-ink-secondary" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14px] font-medium leading-5 text-ink" title={path}>{name}</div>
            <div className="truncate text-[12px] leading-4 text-ink-secondary" title={folder}>
              {[folder, loaded?.size !== undefined ? formatSize(loaded.size) : ""].filter(Boolean).join(" · ")}
            </div>
          </div>
          {loaded && hasSource(loaded.kind) && loaded.text !== undefined && (
            <div className="flex shrink-0 rounded-lg bg-ink/[.05] p-0.5 text-[12px]">
              {(["preview", "source"] as const).map((mode) => (
                <button key={mode} type="button" aria-pressed={(mode === "source") === source} onClick={() => setSource(mode === "source")}
                  className={cn("rounded-md px-2 py-1", (mode === "source") === source ? "bg-app text-ink shadow-sm" : "text-ink-secondary hover:text-ink")}>{mode}</button>
              ))}
            </div>
          )}
          <div className="flex shrink-0 items-center">{actions}</div>
          <button type="button" onClick={onClose} aria-label="close" title="close (esc)" className="rounded-lg p-2 text-ink-secondary hover:bg-raised hover:text-ink"><X size={18} /></button>
        </header>
        <div className={cn("relative min-h-0 flex-1", loaded && (loaded.kind === "pdf" || loaded.kind === "image" || loaded.kind === "video" || (loaded.kind === "html" && !source)) ? "overflow-hidden" : "overflow-auto")}>
          {error ? (
            <div role="alert" className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
              <FileKindIcon name={name} size={36} className="text-ink-secondary" />
              <p className="text-[13.5px] text-ink">couldn&apos;t open {name}</p>
              <p className="text-[12.5px] text-ink-secondary">{error}</p>
              {native && <div className="mt-2 flex gap-2">{actions}</div>}
            </div>
          ) : !loaded ? (
            <div className="flex h-full items-center justify-center text-ink-secondary" role="status"><LoaderCircle size={20} className="animate-spin" /><span className="sr-only">loading {name}</span></div>
          ) : (
            <>
              <FilePreview name={loaded.name} kind={loaded.kind} url={loaded.url} text={loaded.text} source={source} zoom size={loaded.size} empty={actions} />
              {loaded.truncated && <p className="px-4 pb-3 text-[11.5px] text-ink-secondary">showing the start of this file{loaded.size ? ` (${formatSize(loaded.size)})` : ""}</p>}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
