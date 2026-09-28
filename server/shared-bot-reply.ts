import { basename } from "node:path";
import { parseSharedResponseArtifacts } from "./shared-response-artifacts.ts";
import { messageFileTargets, sharedFileReplyText } from "./message-file.ts";

export interface SharedReplyFile { name: string; mime: string; data: string }
export interface SharedBotReply { reply: string; files?: SharedReplyFile[] }
interface ReplyMessage {
  id: string; role: string; kind: string; text?: string; turnTerminal?: boolean;
  attachments?: Array<{ kind: string; path: string }>;
}

/** The caller passes only the current turn, ending at its terminal message.
 * Every file read remains an exact-message capability supplied by the caller. */
export async function collectSharedBotReply(messages: ReplyMessage[], read: (message: ReplyMessage, href: string, generated: boolean) => Promise<SharedReplyFile>): Promise<SharedBotReply> {
  const terminal = messages.findLast(message => message.role === "bot" && message.turnTerminal);
  const artifacts = parseSharedResponseArtifacts(terminal?.text ?? "");
  let reply = sharedFileReplyText(artifacts.text);
  const files: SharedReplyFile[] = [...artifacts.files];
  const seen = new Set<string>();
  const failed = new Set<string>();
  const attempted = new Set<string>();
  for (const message of messages) {
    if (message.role !== "bot" || message.kind !== "text") continue;
    const candidates = [
      ...(message.attachments ?? []).filter(item => item.kind === "image").map(item => ({ href: item.path, generated: true })),
      ...messageFileTargets(message === terminal ? artifacts.text : message.text ?? "").map(href => ({ href, generated: false })),
    ];
    for (const { href, generated } of candidates) {
      if (typeof href !== "string" || href.length > 8192) continue;
      const key = `${generated ? "generated" : "link"}:${href}`;
      if (seen.has(href) || attempted.has(key)) continue;
      attempted.add(key);
      // Room attachment cards carry the downloadable copy. Do not leave a
      // dead host path in the final Markdown link, or publish private paths.

      if (files.length >= 4 || attempted.size > 16) { failed.add(href); continue; }
      try {
        const file = await read(message, href, generated);
        seen.add(href);
        failed.delete(href);
        files.push({ ...file, name: basename(file.name), mime: file.mime.split(";")[0]!.trim() });
      } catch { failed.add(href); }
    }
  }
  if (artifacts.rejected) reply += `${reply ? "\n\n" : ""}The requested text files could not be attached because their format or size was unsupported.`;
  if (failed.size) reply += `${reply ? "\n\n" : ""}Some files could not be shared here. Only supported files from this conversation can be attached (up to four per reply).`;
  return { reply: reply || (files.length ? "Files attached." : ""), ...(files.length ? { files } : {}) };
}
