/** The body of a file viewer: one file rendered the way you would want to
 * read it. Images zoom, video and audio play, pdf and html render, markdown
 * reads as a document, csv as a table, code highlighted. Used by the chat
 * file viewer and the workspace files tab. */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { LoaderCircle } from "lucide-react";

import { ChatMarkdown } from "@/components/ChatMarkdown";
import { FileKindIcon } from "@/components/MediaTokens";
import { ZoomableImage } from "@/components/ZoomableImage";
import { cn } from "@/lib/cn";
import { extensionOf, formatSize, languageFor, parseDelimited, type PreviewKind } from "@/lib/file-preview";

const HIGHLIGHT_MAX = 160 * 1024;
const TABLE_ROWS = 2000;

export function FilePreview({ name, kind, url, text, source = false, zoom = false, size, empty }: {
  name: string;
  kind: PreviewKind;
  /** Object URL of the bytes, for media kinds. */
  url?: string;
  /** Decoded content, for text kinds. */
  text?: string;
  /** Show markdown, html and tables as their source text. */
  source?: boolean;
  /** Pinch/wheel zoom for images; it takes zoom keys window-wide, so only in a modal. */
  zoom?: boolean;
  size?: number;
  /** What to offer when the file has no preview (open with, save a copy). */
  empty?: ReactNode;
}) {
  if (kind === "image" && url) return <ImageView url={url} name={name} zoom={zoom} />;
  if (kind === "video" && url) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center bg-[#0d0d0d] p-4">
        <video src={url} controls playsInline className="max-h-full max-w-full rounded-lg" aria-label={name} />
      </div>
    );
  }
  if (kind === "audio" && url) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-ink-secondary">
        <FileKindIcon name={name} size={36} />
        <audio src={url} controls className="w-full max-w-[520px]" aria-label={name} />
      </div>
    );
  }
  if (kind === "pdf" && url) return <iframe title={name} src={url} className="block h-full w-full border-0 bg-app" />;
  if (text !== undefined) {
    if (kind === "html" && !source) {
      // its own opaque origin: scripts run (charts, reports), but they cannot
      // reach the app, its cookies or the local api
      return <iframe title={name} srcDoc={text} sandbox="allow-scripts" className="block h-full w-full border-0 bg-white" />;
    }
    if (kind === "markdown" && !source) {
      return <div className="mx-auto w-full max-w-[860px] px-6 py-5 text-[14.5px] text-ink"><ChatMarkdown text={text} /></div>;
    }
    if (kind === "table" && !source) return <TableView text={text} delimiter={extensionOf(name) === "tsv" ? "\t" : ","} />;
    return <CodeView text={text} name={name} />;
  }
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <FileKindIcon name={name} size={40} className="text-ink-secondary" />
      <div>
        <div className="text-[14px] font-medium text-ink">{name}</div>
        <div className="mt-0.5 text-[12.5px] text-ink-secondary">
          no preview for {extensionOf(name) ? `.${extensionOf(name)} files` : "this file"}{size !== undefined ? ` · ${formatSize(size)}` : ""}
        </div>
      </div>
      {empty && <div className="mt-1 flex flex-wrap justify-center gap-2">{empty}</div>}
    </div>
  );
}

function ImageView({ url, name, zoom }: { url: string; name: string; zoom: boolean }) {
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  if (failed) return <p role="alert" className="p-6 text-center text-[13px] text-ink-secondary">couldn&apos;t show this image</p>;
  if (!zoom) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <img src={url} alt={name} onError={() => setFailed(true)} className="max-h-full max-w-full object-contain" />
      </div>
    );
  }
  return (
    <div className="relative flex h-full min-h-0 items-center justify-center overflow-hidden bg-[#0d0d0d] p-6">
      {!ready && <LoaderCircle size={20} className="absolute animate-spin text-white/55" />}
      <ZoomableImage src={url} alt={name} ready={ready} onLoad={() => setReady(true)} onError={() => setFailed(true)}
        className={cn("max-h-full max-w-full object-contain transition-opacity", ready ? "opacity-100" : "opacity-0")} />
    </div>
  );
}

function CodeView({ text, name }: { text: string; name: string }) {
  const lang = languageFor(name);
  const [html, setHtml] = useState("");
  useEffect(() => {
    setHtml("");
    if (!text || text.length > HIGHLIGHT_MAX || lang === "text") return;
    let alive = true;
    void import("shiki").then((shiki) => shiki.codeToHtml(text, {
      lang: lang in shiki.bundledLanguages ? lang : "text",
      themes: { light: "github-light-default", dark: "github-dark-default" },
      defaultColor: "light-dark()",
    })).then((out) => { if (alive) setHtml(out); }).catch(() => {});
    return () => { alive = false; };
  }, [text, lang]);
  if (!text) return <p className="p-4 text-[12.5px] text-ink-secondary">this file is empty</p>;
  if (html) {
    return <div className="chat-md workspace-code text-[12.5px] [&_pre]:min-h-full [&_pre]:!bg-transparent [&_pre]:p-4 [&_pre]:leading-[1.6]" dangerouslySetInnerHTML={{ __html: html }} />;
  }
  // plain text and logs wrap; code keeps its lines
  return <pre className={cn("p-4 font-mono text-[12.5px] leading-[1.6] text-ink", lang === "text" ? "whitespace-pre-wrap break-words" : "whitespace-pre")}>{text}</pre>;
}

function TableView({ text, delimiter }: { text: string; delimiter: string }) {
  const { rows, truncated } = useMemo(() => parseDelimited(text, delimiter, TABLE_ROWS + 1), [text, delimiter]);
  if (!rows.length) return <p className="p-4 text-[12.5px] text-ink-secondary">this file is empty</p>;
  const [head, ...body] = rows;
  const shown = body.slice(0, TABLE_ROWS);
  const width = Math.max(...rows.map((row) => row.length));
  return (
    <div className="min-w-full">
      <table className="border-separate border-spacing-0 text-[12.5px] text-ink">
        <thead className="sticky top-0 z-10 bg-raised">
          <tr>
            <th className="sticky left-0 z-10 border-b border-r border-hairline/60 bg-raised px-2 py-1.5 text-right font-normal text-ink-secondary">#</th>
            {Array.from({ length: width }, (_, column) => (
              <th key={column} className="whitespace-nowrap border-b border-r border-hairline/60 px-3 py-1.5 text-left font-semibold">{head![column] ?? ""}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((row, index) => (
            <tr key={index} className="odd:bg-ink/[.02] hover:bg-ink/[.05]">
              <td className="sticky left-0 border-b border-r border-hairline/40 bg-app px-2 py-1 text-right tabular-nums text-ink-secondary">{index + 1}</td>
              {Array.from({ length: width }, (_, column) => (
                <td key={column} className="max-w-[420px] truncate whitespace-nowrap border-b border-r border-hairline/40 px-3 py-1" title={row[column]}>{row[column] ?? ""}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {(truncated || body.length > TABLE_ROWS) && <p className="px-3 py-2 text-[11.5px] text-ink-secondary">showing the first {TABLE_ROWS} rows</p>}
    </div>
  );
}
