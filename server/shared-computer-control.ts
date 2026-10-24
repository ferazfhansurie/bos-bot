import { TurnResources } from "./turn-resources.ts";

/** A local desktop call competes with ordinary bot turns for the same screen.
 * Leases expire if Electron crashes; human takeover always wins renewal. */
const LEASE_EXPIRY_MS = 40_000;

type SharedComputerLease = { timer: NodeJS.Timeout; generation: number; lastActivity: number };

/** Why the screen is not free, for the remote bot to relay. A person's hold
 * and a busy bot turn need different answers ("wait for them to hand it
 * back" vs "try again shortly"), so they are never collapsed into one. */
export type SharedComputerBlock = { kind: "person"; bot?: string } | { kind: "turn"; bot?: string; task?: string };

export type SharedComputerControlHooks = {
  /** The person holding control of a local computer, or null. */
  personHold: () => { bot?: string } | null;
  /** Free host-screen claims held by local turns that stopped using the
   * screen a while ago. Called only when a shared request wants it. */
  reclaimIdle?: () => void;
  /** Name whoever still holds the host screen, for the refusal. */
  holder?: () => { bot?: string; task?: string } | undefined;
};

export function sharedComputerBlockedText(block: SharedComputerBlock): string {
  if (block.kind === "person") {
    return `The person at this computer has taken control${block.bot ? ` (from ${block.bot}'s computer panel)` : ""}. This call was not performed. Wait until they hand control back, then observe the screen again before acting.`;
  }
  const who = block.bot ? `${block.bot}${block.task ? ` (“${block.task}”)` : ""}` : "Another bot";
  return `${who} is using this computer's screen right now. This call was not performed. Try again in a minute, and observe the screen again before acting.`;
}

export class SharedComputerControl {
  private leases = new Map<string, SharedComputerLease>();
  private resources: TurnResources;
  private hooks: SharedComputerControlHooks;
  constructor(resources: TurnResources, hooks: SharedComputerControlHooks) { this.resources = resources; this.hooks = hooks; }
  acquire(id: string) {
    const owner = { threadId: `shared:${id}`, generation: id };
    const person = this.hooks.personHold();
    if (person) this.refuse(id, { kind: "person", ...person });
    if (!this.resources.claim("computer:host", owner)) {
      this.hooks.reclaimIdle?.();
      if (!this.resources.claim("computer:host", owner)) this.refuse(id, { kind: "turn", ...this.hooks.holder?.() });
    }
    this.arm(id);
  }
  /** Extends a held lease for one long desktop action without re-running the
   * turn checks: a heartbeat while the operation is pending must not lose its
   * own screen to a bot. A person taking control does win: the renewal fails
   * and the desktop aborts the job. Renewing an expired or released id is a
   * no-op — the lease is gone and only acquire can bring it back. */
  renew(id: string) {
    if (!this.leases.has(id)) return;
    const person = this.hooks.personHold();
    if (person) this.refuse(id, { kind: "person", ...person });
    this.arm(id);
  }
  held(id: string): boolean { return this.leases.has(id); }
  private refuse(id: string, block: SharedComputerBlock): never {
    this.release(id);
    throw Object.assign(new Error(sharedComputerBlockedText(block)), { status: 409 });
  }
  /** (Re)arm the expiry timer. The generation counter makes a stale timer a
   * no-op: only the callback of the newest arming may release the lease. */
  private arm(id: string) {
    const previous = this.leases.get(id);
    if (previous) clearTimeout(previous.timer);
    const generation = (previous?.generation ?? 0) + 1;
    this.leases.set(id, {
      timer: setTimeout(() => {
        if (this.leases.get(id)?.generation === generation) this.release(id);
      }, LEASE_EXPIRY_MS),
      generation,
      lastActivity: Date.now(),
    });
  }
  release(id: string) {
    const lease = this.leases.get(id);
    if (lease) { clearTimeout(lease.timer); this.leases.delete(id); }
    this.resources.release({ threadId: `shared:${id}`, generation: id });
  }
  close() { for (const id of this.leases.keys()) this.release(id); }
}
