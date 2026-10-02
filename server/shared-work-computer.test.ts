import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { admitSharedWorkComputer, assertSharedWorkComputerOperation, sharedWorkComputerSchema } from "./shared-work-computer.ts";
const target = { id: randomUUID(), name: "bos-laptop (WSL)" };
const online = [{ id: target.id, terminal: true }];
describe("shared work computer admission", () => {
  it("uses identity rather than hostname", () => expect(admitSharedWorkComputer(target, online, true, true)).toEqual(target));
  it("blocks offline without a local alternative", () => expect(() => admitSharedWorkComputer(target, [], true, true)).toThrow(/offline.*Mac will not be used/));
  it("blocks a disabled transport", () => expect(() => admitSharedWorkComputer(target, online, false, true)).toThrow(/disabled/));
  it("blocks providers that still expose native tools", () => expect(() => admitSharedWorkComputer(target, online, true, false)).toThrow(/disable native Mac tools/));
  it("blocks a revoked terminal grant", () => expect(() => admitSharedWorkComputer(target, [{ id: target.id, terminal: false }], true, true)).toThrow(/terminal grant/));
  it("rejects corrupt saved identities", () => expect(() => admitSharedWorkComputer({ id: "bad", name: "Mac" }, online, true, true)).toThrow(/invalid/));
  it("refuses addresses or hidden options in saved identities", () => expect(sharedWorkComputerSchema.safeParse({ ...target, url: "http://localhost" }).success).toBe(false));
  it("refuses a changed default during a turn", () => expect(() => assertSharedWorkComputerOperation(target, undefined, target.id)).toThrow(/changed/));
  it("refuses another shared computer", () => expect(() => assertSharedWorkComputerOperation(target, target, randomUUID())).toThrow(/another computer/));
  it("accepts an exact pinned destination", () => expect(() => assertSharedWorkComputerOperation(target, target, target.id)).not.toThrow());
});
