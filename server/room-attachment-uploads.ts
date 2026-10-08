import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomic } from "./atomic.ts";

/** Author capabilities for native uploads, scoped to a canonical room.
 * Membership is checked by the handler every time; these receipts grant no reads. */
export class RoomAttachmentUploads {
  private readonly receipts = new Set<string>();
  private readonly file: string;
  constructor(file: string) {
    this.file = file;
    if (!existsSync(file)) return;
    const saved: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(saved) || saved.some(key => typeof key !== "string" || !/^[a-f0-9]{64}$/.test(key))) throw new Error("invalid room upload receipts");
    for (const key of saved) this.receipts.add(key);
  }
  private key(roomId: string, actorId: string, name: string): string {
    return createHash("sha256").update(JSON.stringify([roomId, actorId, name])).digest("hex");
  }
  owns(roomId: string, actorId: string, name: string): boolean { return this.receipts.has(this.key(roomId, actorId, name)); }
  record(roomId: string, actorId: string, name: string): void {
    const key = this.key(roomId, actorId, name);
    if (this.receipts.has(key)) return;
    this.receipts.add(key);
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      writeFileAtomic(this.file, JSON.stringify([...this.receipts]), { mode: 0o600 });
    } catch (error) { this.receipts.delete(key); throw error; }
  }
}

/** Stable retries, without letting a guest reuse a private-store upload id. */
export function roomUploadId(roomId: string, actorId: string, uploadId: string): string {
  const bytes = createHash("sha256").update(JSON.stringify(["room-upload", roomId, actorId, uploadId])).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
