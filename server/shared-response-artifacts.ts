import { fromMarkdown } from "mdast-util-from-markdown";
import type { SharedReplyFile } from "./shared-bot-reply.ts";

const TYPES: Record<string, string> = { txt: "text/plain", md: "text/markdown", csv: "text/csv", tsv: "text/tab-separated-values", json: "application/json" };
const MAX_FILE_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 512 * 1024;

/** This is output serialization, not tool execution. The receiving room owns
 * the resulting attachments; no provider or filesystem capability is added. */
export const SHARED_ARTIFACT_INSTRUCTIONS = `You can create downloadable text artifacts for this room without tools. When the user requests a file, put one top-level fenced block labelled bos-artifacts in your final response. Its JSON must be {"files":[{"name":"brief.md","content":"the complete file text"}]}. Use only .txt, .md, .csv, .tsv or .json filenames without folders, at most four files, each at most 64 KiB of UTF-8 text. JSON files must contain valid JSON. Include the actual complete content, not a host path, URL or instruction to run a tool. The system publishes these as room attachments. Never use this format for examples unless explicitly asked to create the files. No images, PDFs, Office binaries, shell execution, private file access or image-generation capability is provided by this format.`;

export function parseSharedResponseArtifacts(text: string): { text: string; files: SharedReplyFile[]; rejected: boolean } {
  // Avoid parsing unbounded structured output. The caller can still deliver
  // ordinary text; no artifacts from an oversized response are published.
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) return { text, files: [], rejected: text.includes("bos-artifacts") };
  const blocks = fromMarkdown(text).children.filter(node => node.type === "code" && node.lang === "bos-artifacts");
  if (!blocks.length) return { text, files: [], rejected: false };
  let cleaned = text;
  for (const node of [...blocks].reverse()) cleaned = cleaned.slice(0, node.position!.start.offset!) + cleaned.slice(node.position!.end.offset!);
  const reject = () => ({ text: cleaned.trim(), files: [], rejected: true });
  // One envelope is atomic: malformed files cannot produce a misleading partial
  // success or exceed the reply cap through repeated blocks.
  if (blocks.length !== 1) return reject();
  try {
    const block = blocks[0]!;
    if (block.type !== "code" || block.meta) return reject();
    const value: unknown = JSON.parse(block.value);
    if (!value || typeof value !== "object" || Array.isArray(value)) return reject();
    const files = (value as { files?: unknown }).files;
    if (!Array.isArray(files) || !files.length || files.length > 4) return reject();
    const names = new Set<string>();
    const result: SharedReplyFile[] = [];
    for (const item of files) {
      if (!item || typeof item !== "object" || Array.isArray(item)) return reject();
      const { name, content } = item as { name?: unknown; content?: unknown };
      if (typeof name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9 _.-]{0,119}\.(txt|md|csv|tsv|json)$/.test(name) || name.includes("..") || names.has(name.toLowerCase()) || typeof content !== "string") return reject();
      const bytes = Buffer.from(content, "utf8");
      if (!bytes.length || bytes.length > MAX_FILE_BYTES || bytes.includes(0) || content.startsWith("#!")) return reject();
      const extension = name.slice(name.lastIndexOf(".") + 1);
      if (extension === "json") JSON.parse(content);
      names.add(name.toLowerCase());
      result.push({ name, mime: TYPES[extension]!, data: bytes.toString("base64") });
    }
    return { text: cleaned.trim(), files: result, rejected: false };
  } catch { return reject(); }
}
