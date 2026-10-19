/** What a file viewer should do with a file: decided from its name and, when
 * the name says nothing, from the type the server sent. Shared by the chat
 * file viewer and the workspace files tab so both render the same way. */

export type PreviewKind = "image" | "video" | "audio" | "pdf" | "html" | "markdown" | "table" | "text" | "other";

const BY_EXTENSION: Record<string, PreviewKind> = {
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", avif: "image", bmp: "image", ico: "image", svg: "image",
  mp4: "video", m4v: "video", webm: "video", mov: "video",
  mp3: "audio", m4a: "audio", aac: "audio", wav: "audio", flac: "audio", ogg: "audio", opus: "audio",
  pdf: "pdf", html: "html", htm: "html", md: "markdown", markdown: "markdown", mdx: "markdown", csv: "table", tsv: "table",
};

const LANGS: Record<string, string> = {
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "tsx", js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx",
  json: "json", jsonc: "jsonc", md: "markdown", mdx: "mdx", py: "python", rb: "ruby", go: "go", rs: "rust", java: "java", kt: "kotlin",
  swift: "swift", c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp", cs: "csharp", css: "css", scss: "scss", less: "less", html: "html",
  htm: "html", xml: "xml", svg: "xml", yml: "yaml", yaml: "yaml", toml: "toml", sh: "bash", bash: "bash", zsh: "bash", fish: "fish",
  sql: "sql", dart: "dart", php: "php", vue: "vue", svelte: "svelte", graphql: "graphql", gql: "graphql", lua: "lua", r: "r",
  ini: "ini", env: "dotenv", prisma: "prisma", tf: "hcl", ps1: "powershell", bat: "bat", diff: "diff", patch: "diff", csv: "csv",
};
const NAMED: Record<string, string> = { dockerfile: "docker", makefile: "make", gemfile: "ruby", podfile: "ruby", rakefile: "ruby" };
const TEXT_EXTENSIONS = new Set(["txt", "log", "text", "rtf", "srt", "vtt", "conf", "cfg", "properties", "gitignore", "lock"]);

/** The file a chat link names, decoded once the way the server decodes it
 * (server/message-file.ts): a markdown target keeps "%20" for spaces, so the
 * raw href is right for the file request but wrong for a name, a folder or
 * opening it in finder. */
export function linkedFilePath(href: string): string {
  const path = href.split(/[?#]/, 1)[0] || href;
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

export function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

export function extensionOf(path: string): string {
  const name = baseName(path).toLowerCase();
  return name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
}

export function languageFor(path: string): string {
  const name = baseName(path).toLowerCase();
  if (NAMED[name]) return NAMED[name]!;
  return LANGS[extensionOf(path)] ?? "text";
}

/** "other" means: look at the bytes (sniffText) before giving up on it. */
export function previewKind(path: string, mime = ""): PreviewKind {
  const ext = extensionOf(path);
  const known = BY_EXTENSION[ext];
  if (known) return known;
  if (LANGS[ext] || TEXT_EXTENSIONS.has(ext) || NAMED[baseName(path).toLowerCase()]) return "text";
  const type = mime.split(";", 1)[0]!.trim().toLowerCase();
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  if (type === "application/pdf") return "pdf";
  if (type === "text/html") return "html";
  if (type === "text/markdown") return "markdown";
  if (type === "text/csv" || type === "text/tab-separated-values") return "table";
  if (type.startsWith("text/") || type === "application/json") return "text";
  return "other";
}

/** Kinds that read as text and so have a "source" view. */
export const hasSource = (kind: PreviewKind) => kind === "markdown" || kind === "html" || kind === "table";
export const isTextKind = (kind: PreviewKind) => hasSource(kind) || kind === "text";
/** Kinds the viewer shows from the raw bytes rather than decoded text. */
export const isMediaKind = (kind: PreviewKind) => kind === "image" || kind === "video" || kind === "audio" || kind === "pdf";

/** The MIME a blob URL needs for the browser to render it (a pdf iframe
 * shows nothing when the blob came back as octet-stream). */
export function mimeFor(path: string): string {
  const ext = extensionOf(path);
  const map: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", bmp: "image/bmp",
    ico: "image/x-icon", svg: "image/svg+xml", mp4: "video/mp4", m4v: "video/x-m4v", webm: "video/webm", mov: "video/quicktime",
    mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", wav: "audio/wav", flac: "audio/flac", ogg: "audio/ogg", opus: "audio/opus",
    pdf: "application/pdf",
  };
  return map[ext] ?? "";
}

/** Text unless the first bytes hold a NUL, the same test the server uses. */
export function looksLikeText(bytes: Uint8Array): boolean {
  return !bytes.includes(0);
}

/** RFC 4180 rows: quoted fields may hold the delimiter, quotes ("") and newlines. */
export function parseDelimited(text: string, delimiter = ",", maxRows = Infinity): { rows: string[][]; truncated: boolean } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"' && field === "") quoted = true;
    else if (char === delimiter) { row.push(field); field = ""; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      rows.push(row); row = [];
      if (rows.length >= maxRows) return { rows, truncated: i + 1 < text.length };
    } else field += char;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return { rows, truncated: false };
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} b`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kb`;
  return `${(bytes / 1024 / 1024).toFixed(1)} mb`;
}
