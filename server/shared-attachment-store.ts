import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import type { SharedAttachment } from "../shared/multiplayer.ts";

interface Stored extends SharedAttachment { roomId: string; actorId: string; createdAt?: number }
const SAFE_TYPES: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif",
  "application/pdf": "pdf", "text/plain": "txt", "text/csv": "csv", "text/markdown": "md", "text/tab-separated-values": "tsv", "application/json": "json",
  "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/wav": "wav", "video/mp4": "mp4",
};

function matchesBytes(mime: string, bytes: Buffer): boolean {
  if (mime === "image/png") return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mime === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8;
  if (mime === "image/webp") return bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  if (mime === "image/gif") return ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6));
  if (mime === "application/pdf") return bytes.toString("ascii", 0, 5) === "%PDF-";
  if (mime.startsWith("text/") || mime === "application/json") return !bytes.includes(0) && !bytes.subarray(0, 2).equals(Buffer.from("#!"));
  if (mime === "audio/mpeg") return bytes.toString("ascii", 0, 3) === "ID3" || (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0);
  if (mime === "audio/mp4" || mime === "video/mp4") return bytes.toString("ascii", 4, 8) === "ftyp";
  if (mime === "audio/wav") return bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WAVE";
  return true;
}

/** Files are reachable only through a room membership check in the route. */
export class SharedAttachmentStore {
  private readonly folder: string;
  private readonly items = new Map<string, Stored>();

  constructor(folder = join(DATA_DIR, "shared-attachments")) {
    this.folder = folder;
    const index = join(folder, "index.json");
    if (!existsSync(index)) return;
    const parsed = JSON.parse(readFileSync(index, "utf8")) as { version: number; items: Stored[] };
    if (parsed.version !== 1 || !Array.isArray(parsed.items)) throw new Error("invalid shared attachment index");
    for (const item of parsed.items) this.items.set(item.id, item);
  }

  save(roomId: string, actorId: string, name: string, mime: string, base64: string): SharedAttachment {
    if (!/^[\w-]+$/.test(roomId) || !actorId || !name || name.length > 255 || /[\\/\x00-\x1f]/.test(name) ||
        !SAFE_TYPES[mime] || typeof base64 !== "string" ||
        base64.length > 35_000_000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) {
      throw new Error("invalid shared attachment");
    }
    const bytes = Buffer.from(base64, "base64");
    if (bytes.length < 1 || bytes.length > 25 * 1024 * 1024) throw new Error("shared attachment exceeds 25 MB");
    if (mime.startsWith("image/") && bytes.length > 10 * 1024 * 1024) throw new Error("images must be under 10 MB");
    if (!matchesBytes(mime, bytes)) throw new Error("attachment bytes do not match its type");
    const now = Date.now();
    const recent = [...this.items.values()].filter(item => item.roomId === roomId && item.actorId === actorId && (item.createdAt ?? 0) > now - 24 * 60 * 60_000);
    if (recent.length >= 50 || recent.reduce((total, item) => total + item.size, 0) + bytes.length > 100 * 1024 * 1024) {
      throw new Error("room attachment limit reached for today");
    }
    const id = randomUUID();
    const stem = name.replace(/\.[^.]+$/, "").slice(0, 245).trim() || "attachment";
    const safeName = `${stem}.${SAFE_TYPES[mime]}`;
    const item: Stored = { id, roomId, actorId, name: safeName, mime, size: bytes.length, createdAt: now };
    mkdirSync(this.folder, { recursive: true, mode: 0o700 });
    writeFileAtomic(join(this.folder, id), base64, { mode: 0o600 });
    this.items.set(id, item);
    try { this.persist(); }
    catch (error) { this.items.delete(id); unlinkSync(join(this.folder, id)); throw error; }
    return { id, name: safeName, mime, size: bytes.length };
  }

  owns(roomId: string, actorId: string, attachment: unknown): boolean {
    if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) return false;
    const candidate = attachment as SharedAttachment;
    const stored = this.items.get(candidate.id);
    return stored?.roomId === roomId && stored.actorId === actorId &&
      stored.name === candidate.name && stored.mime === candidate.mime && stored.size === candidate.size;
  }

  get(roomId: string, id: string): { attachment: SharedAttachment; data: string } | null {
    const item = this.items.get(id);
    if (!item || item.roomId !== roomId) return null;
    const { name, mime, size } = item;
    return { attachment: { id, name, mime, size }, data: readFileSync(join(this.folder, id), "utf8") };
  }

  private persist(): void {
    mkdirSync(dirname(this.folder), { recursive: true, mode: 0o700 });
    writeFileAtomic(join(this.folder, "index.json"), JSON.stringify({ version: 1, items: [...this.items.values()] }), { mode: 0o600 });
  }
}
