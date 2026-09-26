import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import type { SharedAttachment } from "../shared/multiplayer.ts";

interface Stored extends SharedAttachment { roomId: string; actorId: string }

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
        !/^[\w.+-]+\/[\w.+-]+$/.test(mime) || typeof base64 !== "string" ||
        base64.length > 35_000_000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) {
      throw new Error("invalid shared attachment");
    }
    const bytes = Buffer.from(base64, "base64");
    if (bytes.length < 1 || bytes.length > 25 * 1024 * 1024) throw new Error("shared attachment exceeds 25 MB");
    const id = randomUUID();
    const item: Stored = { id, roomId, actorId, name, mime, size: bytes.length };
    mkdirSync(this.folder, { recursive: true, mode: 0o700 });
    writeFileAtomic(join(this.folder, id), base64, { mode: 0o600 });
    this.items.set(id, item);
    try { this.persist(); }
    catch (error) { this.items.delete(id); unlinkSync(join(this.folder, id)); throw error; }
    return { id, name, mime, size: bytes.length };
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
