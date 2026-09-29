import { realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

export type TurnOwner = { threadId: string; generation: string };

/** One harness owns the data directory. Claims are synchronous and last for
 * the whole turn, not just a click: a screenshot and its following click
 * must see the same desktop. These coordinate app-managed resources; they
 * are not a sandbox for arbitrary shell commands. */
export class TurnResources {
  private readonly owners = new Map<string, Array<{ owner: TurnOwner; shared: boolean }>>();

  blocker(resource: string, owner: TurnOwner, { shared = false } = {}): TurnOwner | undefined {
    for (const [key, claims] of this.owners) {
      if (!overlaps(key, resource)) continue;
      for (const claim of claims) {
        if (!sameOwner(claim.owner, owner) && !(shared && claim.shared && resource.startsWith("workspace:"))) return claim.owner;
      }
    }
    return undefined;
  }

  claim(resource: string, owner: TurnOwner, { shared = false } = {}): boolean {
    // Only project turns can share a resource. A restore uses the default
    // exclusive mode, which blocks every writer, including parallel turns.
    shared = shared && resource.startsWith("workspace:");
    if (this.blocker(resource, owner, { shared })) return false;
    const claims = this.owners.get(resource) ?? [];
    const existing = claims.find(claim => sameOwner(claim.owner, owner));
    if (existing) existing.shared = existing.shared && shared;
    else claims.push({ owner, shared });
    this.owners.set(resource, claims);
    return true;
  }

  owns(resource: string, owner: TurnOwner): boolean {
    return this.owners.get(resource)?.some(claim => sameOwner(claim.owner, owner)) ?? false;
  }

  release(owner: TurnOwner): void {
    for (const resource of this.owners.keys()) this.releaseOne(resource, owner);
  }

  releaseOne(resource: string, owner: TurnOwner): void {
    const claims = this.owners.get(resource)?.filter(claim => !sameOwner(claim.owner, owner));
    if (claims?.length) this.owners.set(resource, claims);
    else this.owners.delete(resource);
  }
}

function sameOwner(a: TurnOwner, b: TurnOwner): boolean {
  return a.threadId === b.threadId && a.generation === b.generation;
}

export function workspaceResource(cwd: string): string {
  // Selected folders must exist before the engine starts. Resolve symlinks
  // and native filename casing so aliases cannot grant two writers to the
  // same project on case-insensitive volumes.
  const canonical = realpathSync.native(resolve(cwd));
  return `workspace:${process.platform === "win32" ? canonical.toLowerCase() : canonical}`;
}

export function overlaps(a: string, b: string): boolean {
  if (a === b) return true;
  if (!a.startsWith("workspace:") || !b.startsWith("workspace:")) return false;
  const left = a.slice("workspace:".length);
  const right = b.slice("workspace:".length);
  const contains = (parent: string, child: string) => {
    const path = relative(parent, child);
    return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !path.startsWith(sep) && !/^[A-Za-z]:/.test(path));
  };
  return contains(left, right) || contains(right, left);
}
