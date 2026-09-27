import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseContactId } from "../shared/multiplayer.ts";
import { canCancelSharedRequest, sharedRequestIsActive, sharedRequestStates, type SharedRequest, type SharedRequestState } from "../shared/shared-request.ts";
import { writeFileAtomic } from "./atomic.ts";

type RequestInput = Pick<SharedRequest, "roomId" | "roomRevision" | "sourceId" | "requesterId" | "botId" | "botName" | "ownerId" | "ownerName" | "createdAt">;
const idPattern = /^[\w-]{1,128}$/;
export function sharedRequestId(roomId: string, sourceId: string, botId: string): string {
  return createHash("sha256").update(JSON.stringify([roomId, sourceId, botId])).digest("hex");
}
function validate(value: SharedRequest): void {
  if (!value || typeof value !== "object") throw new Error("invalid shared request record");
  const bot = parseContactId(value.botId);
  if (!value || !idPattern.test(value.roomId) || !idPattern.test(value.sourceId) ||
      value.id !== sharedRequestId(value.roomId, value.sourceId, value.botId) ||
      parseContactId(value.requesterId)?.kind !== "person" || bot?.kind !== "bot" ||
      value.ownerId !== `${bot.homeId}:person:owner` ||
      !Number.isSafeInteger(value.roomRevision) || value.roomRevision < 1 ||
      ![value.createdAt, value.updatedAt].every(time => Number.isSafeInteger(time) && time >= 0) ||
      !sharedRequestStates.includes(value.state) ||
      ![value.botName, value.ownerName].every(name => typeof name === "string" && name.length > 0 && name.length <= 200) ||
      (value.dispatchedAt !== undefined && (!Number.isSafeInteger(value.dispatchedAt) || value.dispatchedAt < 0)) ||
      (value.resultId !== undefined && !idPattern.test(value.resultId)) ||
      (value.explanation !== undefined && (typeof value.explanation !== "string" || value.explanation.length > 500)) ||
      (value.cancelledBy !== undefined && value.cancelledBy !== value.requesterId && value.cancelledBy !== value.ownerId)) {
    throw new Error("invalid shared request record");
  }
}

/** Write before dispatch. A terminal receipt cannot be reopened by a send retry. */
export class SharedRequestStore {
  private readonly records = new Map<string, SharedRequest>();
  private readonly file: string;
  constructor(file: string) {
    this.file = file;
    if (!existsSync(file)) return;
    // Fail closed: losing dispatch receipts must never turn into duplicate work.
    const saved = JSON.parse(readFileSync(file, "utf8"));
    if (saved?.version !== 1 || !Array.isArray(saved.requests)) throw new Error("invalid shared request store");
    for (const record of saved.requests) {
      validate(record);
      if (this.records.has(record.id)) throw new Error("duplicate shared request record");
      this.records.set(record.id, record);
    }
  }
  get(id: string): SharedRequest | undefined { const record = this.records.get(id); return record && { ...record }; }
  all(): SharedRequest[] { return [...this.records.values()].map(record => ({ ...record })); }
  forRoom(roomId: string): SharedRequest[] { return this.all().filter(record => record.roomId === roomId).sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id)); }
  ensure(input: RequestInput): SharedRequest {
    const id = sharedRequestId(input.roomId, input.sourceId, input.botId);
    const previous = this.get(id);
    if (previous) return previous;
    return this.save({ ...input, id, state: "accepted", updatedAt: input.createdAt });
  }
  transition(id: string, state: SharedRequestState, details: Pick<Partial<SharedRequest>, "explanation" | "resultId" | "cancelledBy"> = {}): SharedRequest {
    const previous = this.get(id);
    if (!previous) throw new Error("shared request unavailable");
    if (!sharedRequestIsActive(previous.state)) return previous;
    if (previous.dispatchedAt && (state === "accepted" || state === "queued")) throw new Error("a dispatched request cannot be queued again");
    const now = Date.now();
    return this.save({ ...previous, ...details, state, updatedAt: now,
      ...(state === "working" && !previous.dispatchedAt ? { dispatchedAt: now } : {}) });
  }
  cancel(id: string, actorId: string): SharedRequest {
    const previous = this.get(id);
    if (!previous || (previous.requesterId !== actorId && previous.ownerId !== actorId)) throw new Error("only the requester or bot owner can stop this request");
    if (!canCancelSharedRequest(previous, actorId)) return previous;
    return this.transition(id, "cancelled", { cancelledBy: actorId,
      explanation: previous.dispatchedAt ? "Stop requested. Any work already performed cannot be undone." : "Cancelled before the bot started." });
  }
  private save(record: SharedRequest): SharedRequest {
    validate(record);
    const previous = this.records.get(record.id);
    this.records.set(record.id, record);
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      writeFileAtomic(this.file, JSON.stringify({ version: 1, requests: [...this.records.values()] }), { mode: 0o600 });
    } catch (error) {
      if (previous) this.records.set(record.id, previous); else this.records.delete(record.id);
      throw error;
    }
    return { ...record };
  }
}
