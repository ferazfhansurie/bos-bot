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

/** Workspace restore onto another home. The ledger names the home owner it was
 * written for, while the destination keeps its own environment identity, so a
 * foreign ledger would make the restored server refuse to start. Rebase it to
 * the destination owner without granting anything the source did not have:
 * - the source owner and every other source-home person or bot are dropped
 *   (those ids cannot exist here; the source owner never becomes a member);
 * - the destination owner is dropped from members (it is already the owner);
 * - other people keep exactly their source role; room bot grants keep only
 *   bots from other homes. Restored local bots must be granted again.
 * The source ledger is fully validated first and the result is validated
 * against the destination owner before returning. Same-home ledgers are only
 * validated, never changed. A missing file stays missing. */
export function rebaseWorkspaceMembershipLedger(file: string, ownerId: string): void {
  person(ownerId);
  if (!existsSync(file)) return;
  const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<Snapshot> | null;
  const sourceOwnerId = raw && typeof raw === "object" ? raw.ownerId : undefined;
  const sourceOwner = parseContactId(sourceOwnerId);
  if (sourceOwner?.kind !== "person" || sourceOwner.localId !== "owner") throw new Error("invalid workspace membership ledger");
  if (sourceOwnerId === ownerId) {
    new WorkspaceMembership(file, ownerId);
    return;
  }
  // Full validation as the ledger its source home would have read.
  new WorkspaceMembership(file, sourceOwnerId as string);
  const snapshot = JSON.parse(readFileSync(file, "utf8")) as Snapshot;
  const portable = (id: string) => parseContactId(id)?.homeId !== sourceOwner.homeId;
  const members = snapshot.members
    .filter(member => portable(member.actorId) && member.actorId !== ownerId)
    .map(member => ({ actorId: member.actorId, role: member.role }));
  const roomBotGrants = snapshot.roomBotGrants
    .map(grant => ({ roomId: grant.roomId, botIds: grant.botIds.filter(portable) }))
    .filter(grant => grant.botIds.length > 0);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileAtomic(file, JSON.stringify({ version: 1, ownerId, members, roomBotGrants } satisfies Snapshot), { mode: 0o600 });
  new WorkspaceMembership(file, ownerId);
}
