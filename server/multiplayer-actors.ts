import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomic } from "./atomic.ts";
import { contactId, parseContactId } from "../shared/multiplayer.ts";

interface ActorBinding {
  sessionId: string;
  personId: string;
  name: string;
}

interface Snapshot { version: 1; bindings: ActorBinding[] }

/** Explicit owner-controlled mapping from device sessions to people.
 * Device labels and email strings are never interpreted as an actor. */
export class MultiplayerActors {
  private readonly bindings = new Map<string, ActorBinding>();
  private readonly file: string;
  readonly ownerId: string;

  constructor(file: string, homeId: string) {
    this.file = file;
    this.ownerId = contactId({ homeId, kind: "person", localId: "owner" });
    if (!existsSync(file)) return;
    let snapshot: Snapshot;
    try { snapshot = JSON.parse(readFileSync(file, "utf8")) as Snapshot; }
    catch { throw new Error("could not read actor bindings"); }
    if (snapshot.version !== 1 || !Array.isArray(snapshot.bindings)) throw new Error("invalid actor bindings");
    for (const binding of snapshot.bindings) {
      this.validate(binding.sessionId, binding.personId, binding.name);
      if (this.bindings.has(binding.sessionId)) throw new Error("duplicate actor binding");
      this.bindings.set(binding.sessionId, binding);
    }
  }

  actorFor(sessionId: string): string | null {
    return this.bindings.get(sessionId)?.personId ?? null;
  }

  bindingFor(sessionId: string): { personId: string; name: string } | null {
    const binding = this.bindings.get(sessionId);
    return binding ? { personId: binding.personId, name: binding.name } : null;
  }

  nameFor(personId: string): string | null {
    if (personId === this.ownerId) return null;
    for (const binding of this.bindings.values()) if (binding.personId === personId) return binding.name;
    return null;
  }

  bind(sessionId: string, personId: string, name: string): void {
    this.validate(sessionId, personId, name);
    const previous = this.bindings.get(sessionId);
    this.bindings.set(sessionId, { sessionId, personId, name: name.trim() });
    try { this.persist(); }
    catch (error) {
      if (previous) this.bindings.set(sessionId, previous);
      else this.bindings.delete(sessionId);
      throw error;
    }
  }

  unbind(sessionId: string): boolean {
    const previous = this.bindings.get(sessionId);
    if (!previous) return false;
    this.bindings.delete(sessionId);
    try { this.persist(); }
    catch (error) { this.bindings.set(sessionId, previous); throw error; }
    return true;
  }

  list(): ActorBinding[] { return [...this.bindings.values()]; }

  people(ownerName: string): Array<{ id: string; name: string; kind: "person" }> {
    const names = new Map<string, string>([[this.ownerId, ownerName.trim() || "Owner"]]);
    for (const binding of this.bindings.values()) if (binding.personId !== this.ownerId) names.set(binding.personId, binding.name);
    return [...names].map(([id, name]) => ({ id, name, kind: "person" }));
  }

  private validate(sessionId: string, personId: string, name: string): void {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(sessionId)) throw new Error("invalid session id");
    if (parseContactId(personId)?.kind !== "person") throw new Error("invalid person id");
    if (typeof name !== "string" || !name.trim() || name.length > 80) throw new Error("invalid person name");
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const snapshot: Snapshot = { version: 1, bindings: this.list() };
    writeFileAtomic(this.file, JSON.stringify(snapshot), { mode: 0o600 });
  }
}
