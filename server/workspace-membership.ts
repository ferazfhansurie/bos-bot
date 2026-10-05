import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseContactId } from "../shared/multiplayer.ts";
import type { RoomBotGrants, WorkspaceMember, WorkspaceRole } from "../shared/workspace-membership.ts";
import { writeFileAtomic } from "./atomic.ts";

type AssignedRole = Exclude<WorkspaceRole, "owner">;
interface Snapshot { version: 1; ownerId: string; members: WorkspaceMember[]; roomBotGrants: RoomBotGrants[] }
const roles: AssignedRole[] = ["admin", "member", "client-guest"];
function person(actorId: unknown): void {
  if (parseContactId(actorId)?.kind !== "person") throw new Error("invalid person actor id");
}
function room(roomId: unknown): void {
  if (typeof roomId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(roomId)) throw new Error("invalid room id");
}
function bots(botIds: unknown): asserts botIds is string[] {
  if (!Array.isArray(botIds) || botIds.some(id => parseContactId(id)?.kind !== "bot") || new Set(botIds).size !== botIds.length) {
    throw new Error("invalid room bot grants");
  }
}

/** The configured owner is immutable. Callers enforce management authorization
 * before mutation. Revalidate disk on every operation: corrupt authority cannot
 * survive in a permissive cache or be replaced with an empty ledger. */
export class WorkspaceMembership {
  readonly ownerId: string;
  private readonly file: string;
  constructor(file: string, ownerId: string, legacyActors?: string[]) {
    person(ownerId);
    this.file = file;
    this.ownerId = ownerId;
    this.read();
    // One-time upgrade: explicitly bound existing people keep the member
    // access they had before roles existed. New bindings default to guest.
    if (legacyActors && !existsSync(file)) {
      const actors = [...new Set(legacyActors)].filter(actor => actor !== ownerId);
      actors.forEach(person);
      this.persist({ version: 1, ownerId, members: actors.map(actorId => ({ actorId, role: "member" })), roomBotGrants: [] });
    }
  }
  role(actorId: string): WorkspaceRole {
    person(actorId);
    const snapshot = this.read();
    return actorId === this.ownerId ? "owner" : snapshot.members.find(member => member.actorId === actorId)?.role ?? "client-guest";
  }
  list(): WorkspaceMember[] {
    return [{ actorId: this.ownerId, role: "owner" }, ...this.read().members];
  }
  canManage(actorId: string): boolean {
    const role = this.role(actorId);
    return role === "owner" || role === "admin";
  }
  set(actorId: string, role: AssignedRole): WorkspaceMember {
    person(actorId);
    const snapshot = this.read();
    if (actorId === this.ownerId || !roles.includes(role)) throw new Error("workspace owner is immutable or role is invalid");
    const member = { actorId, role };
    snapshot.members = snapshot.members.filter(existing => existing.actorId !== actorId);
    snapshot.members.push(member);
    this.persist(snapshot);
    return { ...member };
  }
  remove(actorId: string): boolean {
    person(actorId);
    const snapshot = this.read();
    if (actorId === this.ownerId) throw new Error("workspace owner is immutable");
    const remaining = snapshot.members.filter(member => member.actorId !== actorId);
    if (remaining.length === snapshot.members.length) return false;
    snapshot.members = remaining;
    this.persist(snapshot);
    return true;
  }
  grants(roomId: string): string[] {
    room(roomId);
    return this.read().roomBotGrants.find(grant => grant.roomId === roomId)?.botIds ?? [];
  }
  setGrants(roomId: string, botIds: string[]): void {
    room(roomId);
    bots(botIds);
    const snapshot = this.read();
    snapshot.roomBotGrants = snapshot.roomBotGrants.filter(grant => grant.roomId !== roomId);
    if (botIds.length) snapshot.roomBotGrants.push({ roomId, botIds: [...botIds] });
    this.persist(snapshot);
  }
  private read(): Snapshot {
    let contents: string;
    try { contents = readFileSync(this.file, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, ownerId: this.ownerId, members: [], roomBotGrants: [] };
      throw error;
    }
    const snapshot = JSON.parse(contents) as Snapshot;
    if (!snapshot || snapshot.version !== 1 || snapshot.ownerId !== this.ownerId || !Array.isArray(snapshot.members) || !Array.isArray(snapshot.roomBotGrants)) {
      throw new Error("invalid workspace membership ledger");
    }
    const actors = new Set<string>(), rooms = new Set<string>();
    for (const member of snapshot.members) {
      if (!member || typeof member !== "object") throw new Error("invalid workspace member");
      person(member.actorId);
      if (member.actorId === this.ownerId || actors.has(member.actorId) || !roles.includes(member.role as AssignedRole)) throw new Error("invalid workspace member role");
      actors.add(member.actorId);
    }
    for (const grant of snapshot.roomBotGrants) {
      if (!grant || typeof grant !== "object") throw new Error("invalid room bot grants");
      room(grant.roomId);
      bots(grant.botIds);
      if (rooms.has(grant.roomId)) throw new Error("duplicate room bot grants");
      rooms.add(grant.roomId);
    }
    return snapshot;
  }
  private persist(snapshot: Snapshot): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    // No in-memory authority is changed before durable replacement succeeds.
    writeFileAtomic(this.file, JSON.stringify(snapshot), { mode: 0o600 });
  }
}
