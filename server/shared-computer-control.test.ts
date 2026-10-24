import { afterEach, describe, expect, it } from "vitest";
import { SharedComputerControl } from "./shared-computer-control.ts";
import { TurnResources } from "./turn-resources.ts";

const ID = "79fd2468-e47e-4975-b7bb-5cbb734276b7";
const turn = { threadId: "local-thread", generation: "g1" };

describe("SharedComputerControl", () => {
  let control: SharedComputerControl | undefined;
  afterEach(() => control?.close());

  it("names a person's hold instead of a busy bot", () => {
    const resources = new TurnResources();
    control = new SharedComputerControl(resources, { personHold: () => ({ bot: "bos" }) });
    expect(() => control!.acquire(ID)).toThrow(/person at this computer has taken control \(from bos's computer panel\)/);
    expect(control.held(ID)).toBe(false);
  });

  it("names the bot turn holding the screen", () => {
    const resources = new TurnResources();
    resources.claim("computer:host", turn);
    control = new SharedComputerControl(resources, { personHold: () => null, holder: () => ({ bot: "bos", task: "2.1.9 blank tab" }) });
    let error: (Error & { status?: number }) | undefined;
    try { control.acquire(ID); } catch (caught) { error = caught as Error & { status?: number }; }
    expect(error?.status).toBe(409);
    expect(error?.message).toMatch(/^bos \(“2.1.9 blank tab”\) is using this computer's screen/);
    expect(error?.message).not.toMatch(/person/);
  });

  it("takes the screen once an idle turn's claim is reclaimed", () => {
    const resources = new TurnResources();
    resources.claim("computer:host", turn);
    let reclaimed = 0;
    control = new SharedComputerControl(resources, {
      personHold: () => null,
      reclaimIdle: () => { reclaimed++; resources.releaseOne("computer:host", turn); },
    });
    control.acquire(ID);
    expect(reclaimed).toBe(1);
    expect(control.held(ID)).toBe(true);
    expect(resources.claim("computer:host", turn)).toBe(false);
    control.release(ID);
    expect(resources.claim("computer:host", turn)).toBe(true);
  });

  it("a person taking control mid-job fails the next renewal and frees the screen", () => {
    const resources = new TurnResources();
    let person: { bot?: string } | null = null;
    control = new SharedComputerControl(resources, { personHold: () => person });
    control.acquire(ID);
    control.renew(ID);
    expect(control.held(ID)).toBe(true);
    person = { bot: "bos" };
    expect(() => control!.renew(ID)).toThrow(/taken control/);
    expect(control.held(ID)).toBe(false);
    expect(resources.claim("computer:host", turn)).toBe(true);
  });

  it("renewing a released lease stays a no-op", () => {
    const resources = new TurnResources();
    control = new SharedComputerControl(resources, { personHold: () => ({}) });
    expect(() => control!.renew(ID)).not.toThrow();
    expect(control.held(ID)).toBe(false);
  });
});
