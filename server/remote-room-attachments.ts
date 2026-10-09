import { basename, extname, resolve } from "node:path";
import { ATTACHMENTS_DIR, IMAGE_MAX_BYTES, fileMimeForExtension } from "./attachments.ts";
import { messageAttachments, openMessageFile, readOpenedMessageFile } from "./message-file.ts";
import type { MultiplayerLinks } from "./multiplayer-links.ts";

const UUID_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.[a-z0-9]+$/;
const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\r/g, "&#13;").replace(/\n/g, "&#10;").replace(/\t/g, "&#9;");

/** Read only native private-store files, never workspace paths or examples. */
export async function uploadRemoteRoomAttachments(links: Pick<MultiplayerLinks, "uploadGroupAttachment">, homeId: string, groupId: string, text: string, check: () => void): Promise<string> {
  const tags = messageAttachments(text);
  const replacements: Array<{ start: number; end: number; text: string }> = [];
  const paths = new Map<string, string>();
  for (const tag of tags) {
    check();
    const name = basename(tag.path);
    const id = UUID_FILE.exec(name)?.[1];
    if (!id || resolve(tag.path) !== resolve(ATTACHMENTS_DIR, name)) throw Object.assign(new Error("that attachment is not in this home's attachment store"), { status: 400 });
    let path = paths.get(tag.path);
    if (!path) {
      const file = await openMessageFile(tag.path, [ATTACHMENTS_DIR]);
      try {
        if (tag.kind === "image" && (!file.mime.startsWith("image/") || file.bytes > IMAGE_MAX_BYTES)) throw Object.assign(new Error("unsupported or oversized image"), { status: 413 });
        const mime = fileMimeForExtension(extname(name)) ?? file.mime;
        const bytes = await readOpenedMessageFile(file);
        check();
        path = await links.uploadGroupAttachment(homeId, groupId, bytes, mime, tag.name ?? name, id);
        check();
        paths.set(tag.path, path);
      } finally { await file.handle.close(); }
    }
    replacements.push({ start: tag.start, end: tag.end, text: `<attached-${tag.kind} path="${escape(path)}"${tag.name === undefined ? "" : ` name="${escape(tag.name)}"`} />` });
  }
  for (const item of replacements.sort((a, b) => b.start - a.start)) text = text.slice(0, item.start) + item.text + text.slice(item.end);
  return text;
}
