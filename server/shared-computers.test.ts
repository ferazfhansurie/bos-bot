import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SharedComputers } from "./shared-computers.ts";
import { SharedComputerControl } from "./shared-computer-control.ts";
import { TurnResources } from "./turn-resources.ts";

const secret = "a".repeat(64);
const registration = () => ({ id: randomUUID(), name: "Desktop", environmentId: randomUUID(), folders: [], terminal: false, computer: false });
afterEach(() => vi.useRealTimers());
describe("shared computer authority and lifecycle", () => {
  it("serves browser calls only from computers that share their browser, beside other work", async () => {
    const broker = new SharedComputers(() => true);
    const plain = registration(), browser = { ...registration(), browser: true };
    broker.register(plain, "owner", secret); broker.register(browser, "owner", secret);
    try {
      expect(broker.browsers("bot").map(computer => computer.id)).toEqual([browser.id]);
      const call = (computer_id: string, thread_id: string) => ({ computer_id, action: "browser_rpc" as const, method: "tools/list" as const, bot_id: "bot", thread_id, generation: "g" });
      await expect(broker.request(call(plain.id, "t"), () => true, "bot")).rejects.toMatchObject({ status: 403 });
      const pending = Array.from({ length: 8 }, (_, n) => broker.request(call(browser.id, `t${n}`), () => true, "bot"));
      await expect(broker.request(call(browser.id, "t9"), () => true, "bot")).rejects.toThrow(/busy/);
      const files = broker.request({ computer_id: browser.id, action: "list_files" }, () => true);
      await expect(broker.request({ computer_id: browser.id, action: "list_files" }, () => true)).rejects.toThrow(/busy/);
      for (let n = 0; n < 9; n++) {
        const job = await broker.poll(browser.id, "owner", secret);
        broker.complete(browser.id, "owner", secret, job!.id, { n });
      }
      await expect(Promise.all(pending)).resolves.toHaveLength(8);
      await expect(files).resolves.toBeTruthy();
    } finally { broker.close(); }
  });
  it("requires both the owning paired session and the connector secret", async () => {
    const broker = new SharedComputers(id => id === "owner");
    const computer = registration(); broker.register(computer, "owner", secret);
    for (const [owner, key] of [["intruder", secret], ["owner", "wrong"], ["owner", "é".repeat(64)]]) {
      await expect(broker.poll(computer.id, owner, key)).rejects.toMatchObject({ status: 403 });
    }
    expect(() => broker.register(computer, "intruder", secret)).toThrow(/not authorized/);
    expect(JSON.stringify(broker.list())).not.toContain(secret);
    broker.close();
  });
  it("delivers a job once, refuses concurrent work, and never replays after disconnect", async () => {
    const broker = new SharedComputers(() => true);
    const computer = registration(); broker.register(computer, "owner", secret);
    const operation = { computer_id: computer.id, action: "list_files" as const };
    const result = broker.request(operation, () => true);
    await expect(broker.request(operation, () => true)).rejects.toThrow(/busy/);
    const job = await broker.poll(computer.id, "owner", secret);
    expect(job?.operation).toEqual(operation);
    expect(broker.liveJob(computer.id, "owner", secret, job!.id)).toBe(true);
    broker.complete(computer.id, "owner", secret, job!.id, { ok: true });
    await expect(result).resolves.toEqual({ ok: true });
    expect(() => broker.complete(computer.id, "owner", secret, job!.id, {})).toThrow(/expired/);
    const pending = broker.request(operation, () => true);
    const rejection = expect(pending).rejects.toThrow(/in-flight/);
    await broker.poll(computer.id, "owner", secret);
    broker.disconnect(computer.id, "owner", secret); await rejection;
    expect(broker.list()).toEqual([]);
    await expect(broker.request(operation, () => true)).rejects.toThrow(/offline/);
    broker.close();
  });
  it("routes independently to two granted computers and revokes only the selected one", async () => {
    const broker = new SharedComputers(() => true);
    const first = { ...registration(), name: "Laptop" }, second = { ...registration(), name: "Desktop" };
    const secondSecret = "b".repeat(64);
    try {
      broker.register(first, "laptop-owner", secret);
      broker.register(second, "desktop-owner", secondSecret);
      expect(broker.list().map(computer => computer.id)).toEqual([first.id, second.id]);
      const firstOperation = { computer_id: first.id, action: "list_files" as const };
      const secondOperation = { computer_id: second.id, action: "list_files" as const };
      const firstResult = broker.request(firstOperation, () => true);
      const secondResult = broker.request(secondOperation, () => true);
      const firstJob = await broker.poll(first.id, "laptop-owner", secret);
      const secondJob = await broker.poll(second.id, "desktop-owner", secondSecret);
      expect(firstJob?.operation).toEqual(firstOperation);
      expect(secondJob?.operation).toEqual(secondOperation);
      expect(firstJob!.id).not.toBe(secondJob!.id);
      const revoked = expect(firstResult).rejects.toThrow(/in-flight/);
      broker.disconnect(first.id, "laptop-owner", secret);
      await revoked;
      expect(broker.list()).toEqual([second]);
      await expect(broker.request(firstOperation, () => true)).rejects.toThrow(/offline/);
      expect(broker.liveJob(second.id, "desktop-owner", secondSecret, secondJob!.id)).toBe(true);
      broker.complete(second.id, "desktop-owner", secondSecret, secondJob!.id, { computer: "desktop" });
      await expect(secondResult).resolves.toEqual({ computer: "desktop" });
      const nextResult = broker.request(secondOperation, () => true);
      const nextJob = await broker.poll(second.id, "desktop-owner", secondSecret);
      broker.complete(second.id, "desktop-owner", secondSecret, nextJob!.id, { stillUsable: true });
      await expect(nextResult).resolves.toEqual({ stillUsable: true });
    } finally { broker.close(); }
  });
  it("turn cancellation rejects queued and already delivered actions", async () => {
    vi.useFakeTimers();
    const broker = new SharedComputers(() => true);
    const computer = registration(); broker.register(computer, "owner", secret);
    let active = true;
    const pending = broker.request({ computer_id: computer.id, action: "list_files" }, () => active);
    const rejection = expect(pending).rejects.toThrow(/turn ended/);
    const job = await broker.poll(computer.id, "owner", secret);
    active = false;
    expect(broker.liveJob(computer.id, "owner", secret, job!.id)).toBe(false);
    broker.complete(computer.id, "owner", secret, job!.id, {}); await rejection;
    active = true;
    const queued = broker.request({ computer_id: computer.id, action: "list_files" }, () => active);
    const stopped = expect(queued).rejects.toThrow(/turn ended/);
    active = false;
    const poll = broker.poll(computer.id, "owner", secret);
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(poll).resolves.toBeNull(); await stopped;
    broker.close();
  });
  it("expires offline registrations and rejects revoked sessions", async () => {
    vi.useFakeTimers(); let valid = true;
    const broker = new SharedComputers(() => valid);
    const computer = registration(); broker.register(computer, "owner", secret);
    valid = false; expect(broker.list()).toEqual([]);
    await expect(broker.poll(computer.id, "owner", secret)).rejects.toThrow(/not authorized/);
    valid = true; await vi.advanceTimersByTimeAsync(40_001);
    expect(broker.list()).toEqual([]); broker.close();
  });
});

it("shared screen calls respect local turns, human takeover, lease expiry and release", async () => {
  vi.useFakeTimers();
  const resources = new TurnResources(); let held = false;
  const control = new SharedComputerControl(resources, () => held);
  const local = { threadId: "local", generation: "first" };
  resources.claim("computer:host", local);
  expect(() => control.acquire("remote")).toThrow(/in use locally/);
  resources.release(local); control.acquire("remote");
  expect(resources.claim("computer:host", local)).toBe(false);
  held = true; expect(() => control.acquire("remote")).toThrow(/held by a person/);
  held = false; control.acquire("remote");
  await vi.advanceTimersByTimeAsync(40_001);
  expect(resources.claim("computer:host", local)).toBe(true);
  resources.release(local); control.acquire("remote"); control.close();
  expect(resources.claim("computer:host", local)).toBe(true);
});


describe("bot-scoped shared computer grants", () => {
  it("hides restricted computers and refuses unauthenticated or other bots", async () => {
    const broker = new SharedComputers(() => true);
    const bot = randomUUID(), other = randomUUID();
    const computer = { ...registration(), allowedBotIds: [bot] };
    broker.register(computer, "owner", secret);
    expect(broker.list(bot)).toEqual([computer]);
    expect(broker.list(other)).toEqual([]);
    for (const caller of [undefined, other]) {
      await expect(broker.request({ computer_id: computer.id, action: "list_files" }, () => true, caller)).rejects.toMatchObject({ status: 403 });
    }
    broker.close();
  });
  it("revoking a bot invalidates its delivered lease without replay", async () => {
    const broker = new SharedComputers(() => true);
    const bot = randomUUID(), other = randomUUID();
    const computer = { ...registration(), allowedBotIds: [bot] };
    broker.register(computer, "owner", secret);
    const result = broker.request({ computer_id: computer.id, action: "list_files" }, () => true, bot);
    const rejection = expect(result).rejects.toThrow(/turn ended/);
    const job = await broker.poll(computer.id, "owner", secret);
    broker.register({ ...computer, allowedBotIds: [other] }, "owner", secret);
    expect(broker.liveJob(computer.id, "owner", secret, job!.id)).toBe(false);
    broker.complete(computer.id, "owner", secret, job!.id, {});
    await rejection;
    broker.close();
  });
});
