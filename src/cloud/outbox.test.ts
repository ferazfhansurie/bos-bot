import { describe, expect, it } from "vitest";
import { envelopeProblem, freezeSend, localOutboxStore, memoryOutboxStore, nextWork, outboxLabel, outboxReducer, type OutboxEntry } from "./outbox";

const alice = { service: "cloud-local", issuer: "stub", subject: "alice", account_id: "alice", workspace_id: "w1", epoch: "e1" };
const bob = { ...alice, subject: "bob", account_id: "bob" };

async function frozen(text: string, nonce: string, room = "r1"): Promise<OutboxEntry> {
  const result = await freezeSend({
    namespace: alice,
    window_id: "window1",
    window_token: "token",
    room_id: room,
    thread_id: "t1",
    text,
    mentions: [],
    expected_policy_revision: "1",
    now: 1_000,
    nonce,
  });
  if ("problem" in result) throw new Error(result.problem);
  return result;
}

const accepted = (id: string, sequence: string) =>
  ({ status: "accepted", client_operation_id: id, digest: "0".repeat(64), message_id: `m${sequence}`, room_id: "r1", thread_id: "t1", sequence, redacted: false, retry: "none" }) as const;

describe("cloud outbox", () => {
  it("freezes the operation id from window and nonce with a stable digest", async () => {
    const a = await frozen("hello", "aaaaaaaaaaaaaaaa");
    const b = await frozen("hello", "aaaaaaaaaaaaaaaa");
    const c = await frozen("hello!", "aaaaaaaaaaaaaaaa");
    expect(a.envelope.client_operation_id).toBe("window1.aaaaaaaaaaaaaaaa");
    expect(a.envelope).toMatchObject({ kind: "message.send", attachment_ids: [], reply_to_message_id: null });
    expect(a.digest).toBe(b.digest);
    expect(a.digest).not.toBe(c.digest);
  });

  it("rejects bad spans and oversized text before freezing", () => {
    const text = "\u{1F600}@ana";
    expect(envelopeProblem(text, [{ kind: "human", id: "ana", start: 1, end: 6 }])).toBe("invalid_mention");
    expect(envelopeProblem(text, [{ kind: "human", id: "ana", start: 2, end: 6 }])).toBeNull();
    expect(envelopeProblem("a".repeat(64 * 1024 + 1), [])).toBe("text_too_large");
    expect(envelopeProblem("   ", [])).toBe("text_empty");
  });

  it("dispatches sequentially per room and retries only the same envelope", async () => {
    const first = await frozen("one", "aaaaaaaaaaaaaaaa");
    const second = await frozen("two", "bbbbbbbbbbbbbbbb");
    const other = await frozen("elsewhere", "cccccccccccccccc", "r2");
    let entries = [first, second, other].reduce((acc, entry) => outboxReducer(acc, { type: "queued", entry }), [] as OutboxEntry[]);
    const ids = (now: number) => nextWork(entries, alice, now).map((work) => `${work.kind}:${work.entry.envelope.text}`);
    expect(ids(1_000)).toEqual(["send:one", "send:elsewhere"]);

    const a = first.envelope.client_operation_id;
    entries = outboxReducer(entries, { type: "dispatching", id: a });
    expect(entries[0]).toMatchObject({ state: "sending", dispatched: true, attempts: 1 });
    entries = outboxReducer(entries, { type: "send_failed", id: a, now: 2_000, failure: { transport: true } });
    expect(entries[0].state).toBe("checking");
    expect(outboxLabel(entries[0])).toBe("checking whether sent");
    expect(ids(2_000)[0]).toBe("lookup:one");

    entries = outboxReducer(entries, { type: "operation_result", now: 2_100, result: { status: "not_found", client_operation_id: a, retry: "unchanged_or_seal" } });
    expect(entries[0]).toMatchObject({ state: "checking", resend_allowed: true });
    const retry = nextWork(entries, alice, 2_100)[0];
    expect(retry.kind).toBe("send");
    expect(retry.entry.envelope).toEqual(first.envelope);

    entries = outboxReducer(entries, { type: "dispatching", id: a });
    entries = outboxReducer(entries, { type: "operation_result", now: 2_200, result: accepted(a, "7") });
    expect(entries[0]).toMatchObject({ state: "accepted", message_id: "m7", sequence: "7" });
    expect(ids(2_200)).toEqual(["send:two", "send:elsewhere"]);
  });

  it("keeps recovery_unknown in reconciliation and never resends it", async () => {
    const entry = await frozen("x", "aaaaaaaaaaaaaaaa");
    const id = entry.envelope.client_operation_id;
    let entries = outboxReducer([], { type: "queued", entry });
    entries = outboxReducer(entries, { type: "dispatching", id });
    entries = outboxReducer(entries, { type: "send_failed", id, now: 0, failure: { transport: true } });
    entries = outboxReducer(entries, { type: "operation_result", now: 0, result: { status: "recovery_unknown", client_operation_id: id, retry: "reconcile_only" } });
    expect(entries[0]).toMatchObject({ state: "checking", recovery_required: true });
    expect(nextWork(entries, alice, 10_000_000).every((work) => work.kind === "lookup")).toBe(true);
    expect(outboxReducer(entries, { type: "dispatching", id })).toBe(entries);
  });

  it("treats a structured 429 as not admitted and a 409 conflict as terminal", async () => {
    const entry = await frozen("x", "aaaaaaaaaaaaaaaa");
    const id = entry.envelope.client_operation_id;
    let entries = outboxReducer([], { type: "queued", entry });
    entries = outboxReducer(entries, { type: "dispatching", id });
    entries = outboxReducer(entries, { type: "send_failed", id, now: 0, failure: { error: "rate_limited", retry_after: 5 } });
    expect(entries[0].state).toBe("sending");
    expect(nextWork(entries, alice, 4_999)).toEqual([]);
    expect(nextWork(entries, alice, 5_000)[0].kind).toBe("send");
    entries = outboxReducer(entries, { type: "dispatching", id });
    entries = outboxReducer(entries, { type: "send_failed", id, now: 0, failure: { error: "operation_conflict" } });
    expect(entries[0]).toMatchObject({ state: "rejected", rejection: "operation_conflict" });
    expect(entries[0].envelope.text).toBe("x");
  });

  it("turns an in-flight send into checking after a crash", async () => {
    const entry = await frozen("x", "aaaaaaaaaaaaaaaa");
    let entries = outboxReducer([], { type: "queued", entry });
    entries = outboxReducer(entries, { type: "dispatching", id: entry.envelope.client_operation_id });
    entries = outboxReducer(entries, { type: "restored", now: 50 });
    expect(entries[0].state).toBe("checking");
  });

  it("requires review for a never-dispatched draft older than 24 hours", async () => {
    const entry = await frozen("x", "aaaaaaaaaaaaaaaa");
    let entries = outboxReducer([], { type: "queued", entry });
    entries = outboxReducer(entries, { type: "tick", now: 1_000 + 24 * 60 * 60 * 1000 + 1 });
    expect(entries[0].review_required).toBe(true);
    expect(nextWork(entries, alice, Number.MAX_SAFE_INTEGER)).toEqual([]);
    entries = outboxReducer(entries, { type: "review_confirmed", id: entry.envelope.client_operation_id, now: 5 });
    expect(nextWork(entries, alice, 5)[0].kind).toBe("send");
  });

  it("never dispatches another account's operation and stores per account", async () => {
    const entries = outboxReducer([], { type: "queued", entry: await frozen("x", "aaaaaaaaaaaaaaaa") });
    expect(nextWork(entries, bob, 0)).toEqual([]);
    const memory = new Map<string, string>();
    const storage = { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => void memory.set(key, value) };
    localOutboxStore(storage, alice).save(entries);
    expect(localOutboxStore(storage, bob).load()).toEqual([]);
    expect(localOutboxStore(storage, alice).load()).toEqual(entries);
    const guest = memoryOutboxStore();
    guest.save(entries);
    expect(guest.load()).toEqual(entries);
  });

  it("lets only unsent drafts and terminal entries be discarded", async () => {
    const entry = await frozen("x", "aaaaaaaaaaaaaaaa");
    const id = entry.envelope.client_operation_id;
    let entries = outboxReducer([], { type: "queued", entry });
    entries = outboxReducer(entries, { type: "dispatching", id });
    expect(outboxReducer(entries, { type: "discard", id })).toHaveLength(1);
    entries = outboxReducer(entries, { type: "stream_accepted", operation_id: id, message_id: "m", sequence: "3" });
    expect(outboxReducer(entries, { type: "discard", id })).toHaveLength(0);
  });

  it("holds never-sent drafts from the old epoch for review without blocking new sends", async () => {
    const draft = await frozen("before the move", "aaaaaaaaaaaaaaaa");
    const checking = { ...(await frozen("in flight", "bbbbbbbbbbbbbbbb", "r2")), state: "checking" as const, dispatched: true };
    const other = { ...(await frozen("other workspace", "cccccccccccccccc", "r3")), envelope: { ...(await frozen("x", "dddddddddddddddd", "r3")).envelope, namespace: { ...alice, workspace_id: "w2" } } };
    let entries = outboxReducer([draft, checking, other], { type: "authority_changed", workspace_id: "w1", epoch: "e2" });
    expect(entries[0]).toMatchObject({ review_required: true, legacy_epoch: "e1", state: "draft" });
    // Anything that may have left the device keeps reconciling; another workspace is untouched.
    expect(entries[1]).toBe(checking);
    expect(entries[2]).toBe(other);
    expect(outboxLabel(entries[0])).toBe("not sent · written before this room moved");
    // A repeat is a no-op and a review confirm never releases the old envelope.
    expect(outboxReducer(entries, { type: "authority_changed", workspace_id: "w1", epoch: "e2" })).toBe(entries);
    expect(outboxReducer(entries, { type: "review_confirmed", id: draft.envelope.client_operation_id, now: 2_000 })).toBe(entries);
    const fresh = { ...(await frozen("after the move", "eeeeeeeeeeeeeeee")), envelope: { ...(await frozen("after the move", "eeeeeeeeeeeeeeee")).envelope, namespace: { ...alice, epoch: "e2" } } };
    entries = [...entries, fresh];
    expect(nextWork(entries, alice, 2_000).map((work) => [work.kind, work.entry.envelope.text])).toEqual([
      ["lookup", "in flight"],
      ["send", "x"],
      ["send", "after the move"],
    ]);
  });
});
