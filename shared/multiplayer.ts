/** Identities and ordered messages shared by separate OpenMausBot homes.
 * Display names never act as keys or authorization. */

export type ContactKind = "person" | "bot";

export interface ContactKey {
  homeId: string;
  kind: ContactKind;
  localId: string;
}

const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

/** A reversible, collision-free key for maps, URLs, and client selection. */
export function contactId(key: ContactKey): string {
  if (!ID.test(key.homeId) || !ID.test(key.localId) || (key.kind !== "person" && key.kind !== "bot")) {
    throw new Error("invalid contact key");
  }
  return `${key.homeId}:${key.kind}:${key.localId}`;
}

export function parseContactId(value: unknown): ContactKey | null {
  if (typeof value !== "string") return null;
  const parts = value.split(":");
  if (parts.length !== 3) return null;
  const [homeId, kind, localId] = parts;
  if (!homeId || !localId || !ID.test(homeId) || !ID.test(localId) || (kind !== "person" && kind !== "bot")) return null;
  return { homeId, kind, localId };
}

export interface SharedTextMessage {
  id: string;
  roomId: string;
  /** Assigned only by the canonical room home. */
  sequence: number;
  actor: ContactKey;
  text: string;
  at: number;
  /** Stable across retries by the same actor. */
  sendId: string;
  /** For a bot answer, the request that caused the turn. */
  responseTo?: string;
  replyTo?: string;
  editedAt?: number;
  deletedAt?: number;
  changeSequence?: number;
  humanMentions?: string[];
  /** Canonical bot identities authorized for this human request, never members. */
  botTargets?: string[];
  attachments?: SharedAttachment[];
  kind?: "text" | "activity";
  tool?: { name: string; ok?: boolean; spoken?: string };
}

export interface SharedAttachment { id: string; name: string; mime: string; size: number }

export interface SharedRoom {
  id: string;
  homeId: string;
  name: string;
  memberIds: string[];
  kind?: "direct" | "group";
  createdAt: number;
  createdBy?: string;
  revision?: number;
  messageVersion?: number;
}

export type SharedSendInput = Pick<SharedTextMessage, "actor" | "text" | "sendId" | "responseTo" | "replyTo" | "humanMentions" | "botTargets" | "attachments" | "kind" | "tool">;

export function validateSharedSend(input: unknown): SharedSendInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid shared send");
  const value = input as Record<string, unknown>;
  const actor = value.actor;
  if (!actor || typeof actor !== "object" || Array.isArray(actor)) throw new Error("invalid actor");
  const key = actor as Record<string, unknown>;
  if (typeof key.homeId !== "string" || typeof key.localId !== "string" ||
      (key.kind !== "person" && key.kind !== "bot")) throw new Error("invalid actor");
  const parsed = parseContactId(`${key.homeId}:${key.kind}:${key.localId}`);
  if (!parsed) throw new Error("invalid actor");
  if (typeof value.text !== "string" || value.text.length > 20_000) throw new Error("invalid message text");
  if (value.replyTo !== undefined && (typeof value.replyTo !== "string" || !ID.test(value.replyTo))) throw new Error("invalid reply reference");
  const humanMentions = value.humanMentions;
  if (humanMentions !== undefined && (!Array.isArray(humanMentions) || humanMentions.length > 50 || humanMentions.some(id => parseContactId(id)?.kind !== "person"))) throw new Error("invalid human mentions");
  const targets = value.botTargets;
  if (targets !== undefined && (parsed.kind !== "person" || !Array.isArray(targets) || targets.length > 10 ||
      new Set(targets).size !== targets.length || targets.some(id => parseContactId(id)?.kind !== "bot"))) throw new Error("invalid bot targets");
  const attachments = value.attachments;
  if (attachments !== undefined && (!Array.isArray(attachments) || attachments.length > 4 || attachments.some(item =>
      !item || typeof item !== "object" || Array.isArray(item) || !ID.test(item.id) ||
      typeof item.name !== "string" || !item.name || item.name.length > 255 ||
      typeof item.mime !== "string" || !/^[\w.+-]+\/[\w.+-]+$/.test(item.mime) ||
      !Number.isSafeInteger(item.size) || item.size < 1 || item.size > 25 * 1024 * 1024))) throw new Error("invalid shared attachments");
  const kind = value.kind ?? "text";
  if (kind !== "text" && kind !== "activity") throw new Error("invalid shared message kind");
  let tool: SharedTextMessage["tool"];
  if (kind === "activity") {
    if (parsed.kind !== "bot" || !value.tool || typeof value.tool !== "object" || Array.isArray(value.tool)) throw new Error("only bots may send activity");
    const rawTool = value.tool as Record<string, unknown>;
    if (typeof rawTool.name !== "string" || !rawTool.name.trim() || rawTool.name.length > 100 ||
        (rawTool.ok !== undefined && typeof rawTool.ok !== "boolean") ||
        (rawTool.spoken !== undefined && (typeof rawTool.spoken !== "string" || rawTool.spoken.length > 500))) throw new Error("invalid shared activity");
    tool = { name: rawTool.name, ...(rawTool.ok === undefined ? {} : { ok: rawTool.ok as boolean }),
      ...(rawTool.spoken === undefined ? {} : { spoken: rawTool.spoken as string }) };
  } else if (!value.text.trim() && (!Array.isArray(attachments) || attachments.length === 0)) throw new Error("empty shared message");
  if (typeof value.sendId !== "string" || !ID.test(value.sendId)) throw new Error("invalid send id");
  if (value.responseTo !== undefined && (typeof value.responseTo !== "string" || !ID.test(value.responseTo))) throw new Error("invalid response id");
  return { actor: parsed, text: value.text.trim(), sendId: value.sendId,
    ...(value.replyTo ? { replyTo: value.replyTo as string } : {}),
    ...(humanMentions ? { humanMentions: humanMentions as string[] } : {}),
    ...(targets ? { botTargets: targets as string[] } : {}),
    ...(kind === "activity" ? { kind, tool } : {}),
    ...(attachments ? { attachments: attachments as SharedAttachment[] } : {}),
    ...(value.responseTo ? { responseTo: value.responseTo as string } : {}) };
}

/** Canonical-home ordering and retry collapse, with no network side effects. */
export class SharedRoomLog {
  private readonly messages: SharedTextMessage[];
  readonly room: SharedRoom;

  constructor(room: SharedRoom, existing: SharedTextMessage[] = []) {
    this.room = room;
    if (!ID.test(room.id) || !ID.test(room.homeId)) throw new Error("invalid room identity");
    if (new Set(room.memberIds).size !== room.memberIds.length || room.memberIds.some(id => !parseContactId(id))) throw new Error("invalid room members");
    this.messages = [...existing];
    const seen = new Set<string>();
    for (let index = 0; index < this.messages.length; index++) {
      const message = this.messages[index];
      if (!message || message.roomId !== room.id || message.sequence !== index + 1 ||
          !parseContactId(contactId(message.actor))) throw new Error("invalid room log");
      const dedupe = `${contactId(message.actor)}:${message.sendId}`;
      if (seen.has(dedupe)) throw new Error("duplicate room send");
      seen.add(dedupe);
    }
  }

  append(raw: unknown, id: string, at: number): { message: SharedTextMessage; created: boolean } {
    const input = validateSharedSend(raw);
    const actorId = contactId(input.actor);
    const request = input.responseTo ? this.messages.find(message => message.id === input.responseTo) : undefined;
    const invoked = input.actor.kind === "bot" && request?.actor.kind === "person" &&
      request.botTargets?.includes(actorId) && this.room.memberIds.includes(contactId(request.actor));
    if (!this.room.memberIds.includes(actorId) && !invoked) throw new Error("actor is not in this room");
    const previous = this.messages.find(message => contactId(message.actor) === actorId && message.sendId === input.sendId);
    if (previous) {
      if (previous.text !== input.text || previous.responseTo !== input.responseTo || previous.replyTo !== input.replyTo || previous.kind !== input.kind ||
          JSON.stringify(previous.botTargets ?? []) !== JSON.stringify(input.botTargets ?? []) ||
          JSON.stringify(previous.tool ?? null) !== JSON.stringify(input.tool ?? null) ||
          JSON.stringify(previous.attachments ?? []) !== JSON.stringify(input.attachments ?? [])) throw new Error("send id conflict");
      return { message: previous, created: false };
    }
    if (input.replyTo && !this.messages.some(message => message.id === input.replyTo && !message.deletedAt)) throw new Error("reply message unavailable");
    if (!ID.test(id) || !Number.isSafeInteger(at) || at < 0) throw new Error("invalid message identity");
    const message: SharedTextMessage = {
      id, roomId: this.room.id, sequence: this.messages.length + 1,
      actor: input.actor, text: input.text, at, sendId: input.sendId,
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      ...(input.humanMentions ? { humanMentions: input.humanMentions } : {}),
      ...(input.botTargets ? { botTargets: input.botTargets } : {}),
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.tool ? { tool: input.tool } : {}),
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
      ...(input.responseTo ? { responseTo: input.responseTo } : {}),
    };
    this.messages.push(message);
    return { message, created: true };
  }

  after(sequence: number, limit = 100): SharedTextMessage[] {
    if (!Number.isSafeInteger(sequence) || sequence < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new Error("invalid room cursor");
    }
    return this.messages.slice(sequence, sequence + limit);
  }

  all(): SharedTextMessage[] { return [...this.messages]; }
}
