import { describe, expect, it, vi } from "vitest";
import fixtures from "../../shared/cloud-protocol/fixtures.json";
import { ERROR_CODES } from "../../shared/cloud-protocol/index";
import type { CloudApi, CloudResult, CloudSession } from "./api";
import { CloudRoomController, type NetworkSource } from "./controller";
import type { OutboxEntry } from "./outbox";

const snapshotStep = (fixtures.reducer_cases as Array<{ steps: Array<{ type: string; snapshot?: unknown }> }>)
  .flatMap((testCase) => testCase.steps)
  .find((step) => step.type === "snapshot");
const snapshot = snapshotStep!.snapshot as Awaited<ReturnType<CloudApi["snapshot"]>> extends CloudResult<infer T> ? T : never;

const session: CloudSession = { baseUrl: "http://127.0.0.1:1", bearer: "b", account_id: "alice", issuer: "test", subject: "alice", service: "bos" };
const room = { workspace_id: "w1", room_id: "r1", thread_id: "t1", policy_revision: "1" };
const window = {
  namespace: { service: "bos", issuer: "test", subject: "alice", account_id: "alice", workspace_id: "w1", epoch: "e1" },
  window_id: "window1",
  window_token: "token1",
  issued_at: "2026-10-07T00:00:00.000Z",
  expires_at: "2099-01-01T00:00:00.000Z",
};

class FakeSocket {
  static last: FakeSocket;
  static created = 0;
  readonly OPEN = 1;
  readyState = 0;
  sent: unknown[] = [];
  private listeners: Record<string, Array<(event: unknown) => void>> = {};
  constructor(readonly url: string) {
    FakeSocket.last = this;
    FakeSocket.created++;
  }
  addEventListener(type: string, listener: (event: unknown) => void) {
    (this.listeners[type] ??= []).push(listener);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    for (const listener of this.listeners.open ?? []) listener({});
  }
  closed() {
    for (const listener of this.listeners.close ?? []) listener({});
  }
  receive(frame: unknown) {
    for (const listener of this.listeners.message ?? []) listener({ data: JSON.stringify(frame) });
  }
}

function memoryStorage() {
  const items = new Map<string, string>();
  return { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => void items.set(key, value) };
}

function fakeApi(overrides: Partial<CloudApi>): CloudApi {
  return {
    openWindow: vi.fn(async () => ({ ok: true, value: window })),
    snapshot: vi.fn(async () => ({ ok: true, value: snapshot })),
    postRead: vi.fn(async () => ({ ok: true, value: snapshot.read })),
    ...overrides,
  } as unknown as CloudApi;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("cloud room controller", () => {
  it("persists the dispatched envelope before sending and recovers a lost response by lookup", async () => {
    // No jitter, so the lookup retry is due at once.
    vi.spyOn(Math, "random").mockReturnValue(0);
    let persistedAtSend: OutboxEntry[] = [];
    const lookup = vi.fn(async (_workspace: string, id: string) => ({
      ok: true as const,
      value: { status: "accepted" as const, client_operation_id: id, digest: "a".repeat(64), message_id: "m11", room_id: "r1", thread_id: "t1", sequence: "11", redacted: false, retry: "none" as const },
    }));
    const store = new Map<string, string>();
    const trackedStorage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value) };
    // The response is lost after the server may have committed.
    const sendTracked = vi.fn(async () => {
      persistedAtSend = JSON.parse([...store.values()][0] ?? "[]");
      return { ok: false as const, failure: { transport: true as const } };
    });
    const controller = new CloudRoomController(session, fakeApi({ send: sendTracked, lookup }), room, trackedStorage, FakeSocket as unknown as typeof WebSocket);
    controller.start();
    expect(await controller.send("hello")).toBeNull();
    await vi.waitFor(() => expect(controller.getState().outbox[0]?.state).toBe("accepted"));
    expect(persistedAtSend[0]).toMatchObject({ state: "sending", dispatched: true });
    expect(lookup).toHaveBeenCalledWith("w1", persistedAtSend[0]!.envelope.client_operation_id);
    expect(sendTracked).toHaveBeenCalledTimes(1);
    controller.stop();
    vi.restoreAllMocks();
  });

  it("authenticates first, subscribes from no cursor and recovers a reset through a snapshot", async () => {
    const api = fakeApi({});
    const controller = new CloudRoomController(session, api, room, null, FakeSocket as unknown as typeof WebSocket);
    controller.start();
    const socket = FakeSocket.last;
    socket.open();
    expect(socket.sent[0]).toEqual({ type: "authenticate", bearer: "b" });
    expect(socket.sent[1]).toMatchObject({ type: "subscribe", room_id: "r1", thread_id: "t1", cursor: null });
    expect(socket.url).toBe("ws://127.0.0.1:1/v2/realtime");

    socket.receive({ type: "reset_required", workspace_id: "w1", room_id: "r1", reason: "cursor_invalid" });
    await flush();
    expect(api.snapshot).toHaveBeenCalledWith("w1", "r1", "t1");
    expect(controller.getState()).toMatchObject({ reset_required: false, cursor: snapshot.cursor, head: snapshot.watermark });
    expect(socket.sent.at(-1)).toMatchObject({ type: "subscribe", cursor: snapshot.cursor, snapshot_id: snapshot.snapshot_id });
    controller.stop();
  });

  it("on authority_changed re-discovers, drops the old window, reloads and resends a reviewed legacy draft under the new epoch", async () => {
    const storage = memoryStorage();
    const moved = { ...window, window_id: "window2", window_token: "token2", namespace: { ...window.namespace, epoch: "e2" } };
    const openWindow = vi.fn(async () => ({ ok: true as const, value: openWindow.mock.calls.length > 1 ? moved : window }));
    const send = vi.fn(async (envelope: { client_operation_id: string }) => ({ ok: true as const, value: { status: "accepted" as const, client_operation_id: envelope.client_operation_id, digest: "a".repeat(64), message_id: "m20", room_id: "r1", thread_id: "t1", sequence: "20", redacted: false, retry: "none" as const } }));
    const offline: NetworkSource = { online: () => false, subscribe: () => () => {} };
    const rediscover = vi.fn();
    // Queue a draft offline under epoch e1 so it never leaves the device.
    const first = new CloudRoomController(session, fakeApi({ openWindow, send } as Partial<CloudApi>), room, storage, FakeSocket as unknown as typeof WebSocket, undefined, offline);
    first.start();
    (first as unknown as { state: { online: boolean } }).state.online = true;
    await (first as unknown as { ensureWindow(): Promise<unknown> }).ensureWindow();
    (first as unknown as { state: { online: boolean } }).state.online = false;
    expect(await first.send("drafted before the move")).toBeNull();
    first.stop();

    const api = fakeApi({ openWindow, send } as Partial<CloudApi>);
    const net: NetworkSource = { online: () => true, subscribe: () => () => {} };
    const controller = new CloudRoomController(session, api, room, storage, FakeSocket as unknown as typeof WebSocket, undefined, net, rediscover);
    // Hold the replay so the cutover lands before the old draft is sent.
    (controller as unknown as { pumping: boolean }).pumping = true;
    controller.start();
    const socket = FakeSocket.last;
    socket.open();
    socket.receive({
      type: "event_batch", workspace_id: "w1", room_id: "r1", cursor: "c9", scanned_sequence: "9", frontier: "9", live: true,
      events: [{ schema_version: 1, workspace_id: "w1", room_id: "r1", event_id: "ev9", sequence: "9", kind: "authority_changed", required: true, payload: { workspace_id: "w1", epoch: "e2", reason: "migration_cutover" } }],
    });
    await flush();
    expect(rediscover).toHaveBeenCalledTimes(1);
    expect(api.snapshot).toHaveBeenCalledWith("w1", "r1", "t1");
    expect(controller.getState()).toMatchObject({ authority_epoch: "e2", reset_required: false, cursor: snapshot.cursor, upgrade_required: false });
    expect(socket.sent.at(-1)).toMatchObject({ type: "subscribe", cursor: snapshot.cursor, snapshot_id: snapshot.snapshot_id });
    const legacy = controller.getState().outbox[0];
    expect(legacy).toMatchObject({ legacy_epoch: "e1", review_required: true, state: "draft" });
    (controller as unknown as { pumping: boolean }).pumping = false;
    await (controller as unknown as { pump(): Promise<void> }).pump();
    expect(send).not.toHaveBeenCalled();

    expect(await controller.confirmReview(legacy.envelope.client_operation_id)).toBeNull();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const resent = send.mock.calls[0][0] as unknown as { text: string; namespace: { epoch: string }; client_operation_id: string };
    expect(resent).toMatchObject({ text: "drafted before the move", namespace: { epoch: "e2" } });
    expect(resent.client_operation_id).not.toBe(legacy.envelope.client_operation_id);
    expect(controller.getState().outbox.map((entry) => entry.envelope.client_operation_id)).toEqual([resent.client_operation_id]);
    controller.stop();
  });

  it("pages older history from the oldest loaded message, one request at a time, and stops at the thread start", async () => {
    const base = snapshot.messages[0]!;
    const message = (sequence: number) => ({ ...base, thread_id: "t1", message_id: `m${sequence}`, client_operation_id: `window1.op${String(sequence).padStart(14, "0")}`, sequence: String(sequence), version: 1 });
    const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => message(from + index));
    let release: () => void = () => {};
    const history = vi
      .fn()
      .mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => (release = resolve));
        return { ok: true as const, value: { messages: range(51, 150), next_before: "51" } };
      })
      .mockImplementationOnce(async () => ({ ok: true as const, value: { messages: range(1, 50), next_before: null } }));
    const api = fakeApi({ history, snapshot: vi.fn(async () => ({ ok: true as const, value: { ...snapshot, thread_id: "t1", messages: range(151, 200) } })) });
    const controller = new CloudRoomController(session, api, room, null, FakeSocket as unknown as typeof WebSocket);
    controller.start();
    FakeSocket.last.open();
    FakeSocket.last.receive({ type: "reset_required", workspace_id: "w1", room_id: "r1", reason: "cursor_invalid" });
    await vi.waitFor(() => expect(controller.getState().messages).toHaveLength(50));
    const first = controller.loadOlder();
    // A second scroll to the top while the page is in flight asks for nothing.
    await controller.loadOlder();
    expect(history).toHaveBeenCalledTimes(1);
    expect(history).toHaveBeenCalledWith("w1", "r1", "t1", "151");
    release();
    await first;
    expect(controller.getState().messages).toHaveLength(150);
    await controller.loadOlder();
    expect(history).toHaveBeenLastCalledWith("w1", "r1", "t1", "51");
    expect(controller.getState()).toMatchObject({ start_loaded: true, older_before: null });
    expect(controller.getState().messages.map((item) => item.sequence)).toEqual(range(1, 200).map((item) => item.sequence));
    await controller.loadOlder();
    expect(history).toHaveBeenCalledTimes(2);
    controller.stop();
  });

  it("restarts after StrictMode's start, stop, start and ignores the old socket closing late", async () => {
    vi.useFakeTimers();
    const controller = new CloudRoomController(session, fakeApi({}), room, null, FakeSocket as unknown as typeof WebSocket);
    controller.start();
    const first = FakeSocket.last;
    controller.stop();
    controller.start();
    const second = FakeSocket.last;
    expect(second).not.toBe(first);
    const created = FakeSocket.created;
    first.closed();
    vi.runOnlyPendingTimers();
    expect(FakeSocket.created).toBe(created);
    second.open();
    expect(second.sent[1]).toMatchObject({ type: "subscribe", room_id: "r1" });
    controller.stop();
    vi.useRealTimers();
  });

  it("keeps a guest outbox out of persistent storage", async () => {
    const storage = memoryStorage();
    const setItem = vi.spyOn(storage, "setItem");
    const controller = new CloudRoomController(session, fakeApi({ send: vi.fn(async () => ({ ok: false as const, failure: { transport: true as const } })), lookup: vi.fn(async () => ({ ok: false as const, failure: { transport: true as const } })) }), { ...room, guest: true }, storage, FakeSocket as unknown as typeof WebSocket);
    controller.start();
    await controller.send("hi");
    expect(controller.getState().outbox).toHaveLength(1);
    expect(setItem).not.toHaveBeenCalled();
    controller.stop();
  });

  it("authenticates a cookie session without a bearer in the first frame", () => {
    const controller = new CloudRoomController({ ...session, bearer: null }, fakeApi({}), room, null, FakeSocket as unknown as typeof WebSocket);
    controller.start();
    FakeSocket.last.open();
    expect(FakeSocket.last.sent[0]).toEqual({ type: "authenticate" });
    controller.stop();
  });

  it("reports identity_unavailable from the stream and keeps reconnecting", () => {
    vi.useFakeTimers();
    const onIdentity = vi.fn();
    const controller = new CloudRoomController(session, fakeApi({}), room, null, FakeSocket as unknown as typeof WebSocket, onIdentity);
    controller.start();
    const socket = FakeSocket.last;
    socket.open();
    socket.receive({ type: "error", error: "identity_unavailable" });
    expect(onIdentity).toHaveBeenCalledWith({ kind: "identity_unavailable", retry_after: undefined });
    expect(controller.getState().removed).toBe(false);
    socket.closed();
    vi.runOnlyPendingTimers();
    expect(FakeSocket.last).not.toBe(socket);
    controller.stop();
    vi.useRealTimers();
  });

  // session_invalid joins the wire error codes in api's slice 2 protocol change.
  it.skipIf(!(ERROR_CODES as readonly string[]).includes("session_invalid"))("stops reconnecting once the stream says the session is invalid", () => {
    vi.useFakeTimers();
    const onIdentity = vi.fn();
    const controller = new CloudRoomController(session, fakeApi({}), room, null, FakeSocket as unknown as typeof WebSocket, onIdentity);
    controller.start();
    const socket = FakeSocket.last;
    socket.open();
    socket.receive({ type: "error", error: "session_invalid" });
    expect(onIdentity).toHaveBeenCalledWith({ kind: "session_invalid" });
    const created = FakeSocket.created;
    socket.closed();
    vi.runOnlyPendingTimers();
    expect(FakeSocket.created).toBe(created);
    vi.useRealTimers();
  });

  describe("offline replay, approvals, attachments, revocation", () => {
    const network = (initial = true) => {
      let online = initial;
      const listeners = new Set<(online: boolean) => void>();
      const source: NetworkSource = { online: () => online, subscribe: (listener) => (listeners.add(listener), () => listeners.delete(listener)) };
      return { source, set(next: boolean) { online = next; for (const listener of listeners) listener(next); } };
    };
    const accepted = (id: string, n: number) => ({ ok: true as const, value: { status: "accepted" as const, client_operation_id: id, digest: "a".repeat(64), message_id: `m${n}`, room_id: "r1", thread_id: "t1", sequence: String(n), redacted: false, retry: "none" as const } });
    const card = { invocation_id: "inv1", attempt: 1, fence_gen: "7", approval_id: "ap1", workspace_id: "w1", room_id: "r1", thread_id: "t1", actor_id: session.account_id, version: 1, effect_id: "e1", digest: "d".repeat(64), title: "t", expires_at: "2099-01-01T00:00:00.000Z", status: "pending" as const, can_view: true, can_decide: true };

    it("queues a send while offline with the saved window and replays it exactly once on reconnect", async () => {
      const net = network(true);
      let n = 10;
      const send = vi.fn(async (envelope: { client_operation_id: string }) => accepted(envelope.client_operation_id, n++));
      const openWindow = vi.fn(async () => ({ ok: true as const, value: window }));
      const storage = memoryStorage();
      const controller = new CloudRoomController(session, fakeApi({ send, openWindow } as Partial<CloudApi>), room, storage, FakeSocket as unknown as typeof WebSocket, undefined, net.source);
      controller.start();
      expect(await controller.send("first")).toBeNull();
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));

      net.set(false);
      expect(await controller.send("while offline")).toBeNull();
      expect(await controller.send("still offline")).toBeNull();
      await flush();
      expect(send).toHaveBeenCalledTimes(1);
      expect(controller.getState().outbox.filter((entry) => entry.state === "draft")).toHaveLength(2);

      // A fresh controller after a reload (still offline) reuses the saved window, never a new one.
      const reloaded = new CloudRoomController(session, fakeApi({ send, openWindow } as Partial<CloudApi>), room, storage, FakeSocket as unknown as typeof WebSocket, undefined, net.source);
      controller.stop();
      reloaded.start();
      expect(await reloaded.send("after reload")).toBeNull();
      expect(openWindow).toHaveBeenCalledTimes(1);

      net.set(true);
      await vi.waitFor(() => expect(reloaded.getState().outbox.filter((entry) => entry.state === "accepted")).toHaveLength(4));
      FakeSocket.last.open();
      await flush();
      const texts = send.mock.calls.map(([envelope]) => (envelope as unknown as { text: string }).text);
      expect(texts).toEqual(["first", "while offline", "still offline", "after reload"]);
      reloaded.stop();
    });

    it("keeps the draft in the composer when offline with no saved window", async () => {
      const net = network(false);
      const controller = new CloudRoomController(session, fakeApi({}), room, memoryStorage(), FakeSocket as unknown as typeof WebSocket, undefined, net.source);
      controller.start();
      expect(await controller.send("hi")).toBe("no_window");
      expect(controller.getState().outbox).toEqual([]);
      controller.stop();
    });

    it("never queues an approval offline and retries a lost decision with the same operation", async () => {
      vi.spyOn(Math, "random").mockReturnValue(0);
      const net = network(false);
      const decideCard = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, failure: { transport: true } })
        .mockResolvedValueOnce({ ok: true, value: { ...card, version: 2, status: "approved", can_decide: false } });
      const controller = new CloudRoomController(session, fakeApi({ decideCard } as Partial<CloudApi>), room, null, FakeSocket as unknown as typeof WebSocket, undefined, net.source);
      controller.start();
      expect(await controller.decide(card, "approve")).toBe("offline");
      expect(decideCard).not.toHaveBeenCalled();
      net.set(true);
      expect(await controller.decide(card, "approve")).toBe("decided");
      expect(decideCard).toHaveBeenCalledTimes(2);
      expect(decideCard.mock.calls[0]).toEqual(decideCard.mock.calls[1]);
      expect(decideCard.mock.calls[0]).toEqual(["w1", "r1", "ap1", { invocation_id: "inv1", attempt: 1, fence_gen: "7", version: 1, effect_id: "e1", digest: "d".repeat(64), decision: "approve" }]);
      expect(controller.getState().runs.cards.ap1.status).toBe("approved");
      expect(await controller.decide({ ...card, status: "approved" }, "deny")).toBe("not_decidable");
      // Members can view a card, but only its bound actor decides.
      expect(await controller.decide({ ...card, actor_id: "someone-else" }, "deny")).toBe("not_decidable");
      controller.stop();
      vi.restoreAllMocks();
    });

    it("reports a lost race as already decided", async () => {
      const decideCard = vi.fn(async () => ({ ok: false as const, failure: { error: "approval_decided", status: 409 } }));
      const controller = new CloudRoomController(session, fakeApi({ decideCard } as Partial<CloudApi>), room, null, FakeSocket as unknown as typeof WebSocket, undefined, network().source);
      controller.start();
      expect(await controller.decide(card, "deny")).toBe("already_decided");
      controller.stop();
    });

    it("uploads to the server-chosen URL, lets the server verify it and sends only ready attachments", async () => {
      const attachment = { attachment_id: "a1", workspace_id: "w1", room_id: "r1", thread_id: "t1", owner_id: session.account_id, object_key: "w1|r1|a1", name: "notes.txt", size: 5, type: "text/plain" as const, checksum: "c".repeat(64), state: "preparing" as const, expires_at: "2099-01-01T00:00:00Z" };
      const allocateAttachment = vi.fn(async () => ({ ok: true as const, value: { attachment, upload_url: "http://127.0.0.1:9/v2/workspaces/w1/attachments/a1/upload?token=x", expires_at: "2099-01-01T00:00:00Z" } }));
      const upload = vi.fn(async () => ({ ok: true as const, value: { ...attachment, state: "uploading" as const } }));
      const completeAttachment = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, failure: { error: "unavailable", status: 503 } })
        .mockResolvedValueOnce({ ok: true, value: { ...attachment, state: "ready" } });
      const send = vi.fn(async (envelope: { client_operation_id: string }) => accepted(envelope.client_operation_id, 20));
      const api = fakeApi({ allocateAttachment, upload, completeAttachment, send } as unknown as Partial<CloudApi>);
      const controller = new CloudRoomController(session, api, room, null, FakeSocket as unknown as typeof WebSocket, undefined, network().source);
      controller.start();
      await controller.attach(new File(["hello"], "notes.txt", { type: "text/plain" }));
      // The client names the room/thread and declares size, type and checksum; the server picks the object key.
      expect(allocateAttachment).toHaveBeenCalledWith("w1", { room_id: "r1", thread_id: "t1", name: "notes.txt", size: 5, type: "text/plain", checksum: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824" });
      expect(upload).toHaveBeenCalledWith("http://127.0.0.1:9/v2/workspaces/w1/attachments/a1/upload?token=x", expect.any(Blob), "text/plain");
      expect(completeAttachment).toHaveBeenCalledTimes(2);
      expect(controller.getUploads()).toMatchObject([{ state: "ready", attachment_id: "a1" }]);
      expect(controller.attachmentName("a1")).toBe("notes.txt");
      expect(await controller.send("", [], ["a1"])).toBeNull();
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
      expect(send.mock.calls[0][0]).toMatchObject({ attachment_ids: ["a1"], text: "" });
      expect(controller.getUploads()).toEqual([]);
      controller.stop();
    });

    it("refuses oversized, empty and disallowed files before any upload", async () => {
      const allocateAttachment = vi.fn();
      const controller = new CloudRoomController(session, fakeApi({ allocateAttachment } as Partial<CloudApi>), room, null, FakeSocket as unknown as typeof WebSocket, undefined, network().source);
      controller.start();
      const big = new File([], "big.png", { type: "image/png" });
      Object.defineProperty(big, "size", { value: 10 * 1024 * 1024 + 1 });
      await controller.attach(big);
      await controller.attach(new File([], "empty.txt", { type: "text/plain" }));
      await controller.attach(new File(["x"], "run.sh", { type: "application/x-sh" }));
      expect(allocateAttachment).not.toHaveBeenCalled();
      expect(controller.getUploads().map((upload) => upload.problem)).toEqual(["too large", "empty file", "only png, jpeg, pdf or plain text"]);
      controller.stop();
    });

    it("losing the room mid-session drops uploads, revokes viewed files and refuses new downloads and sends", async () => {
      const download = vi.fn(async () => ({ ok: true as const, value: new Blob(["x"]) }));
      const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
      vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:one");
      const controller = new CloudRoomController(session, fakeApi({ download } as Partial<CloudApi>), room, null, FakeSocket as unknown as typeof WebSocket, undefined, network().source);
      controller.start();
      FakeSocket.last.open();
      expect(await controller.download("a1")).toEqual({ url: "blob:one", type: "" });
      FakeSocket.last.receive({ type: "error", error: "forbidden" });
      await flush();
      expect(revoke).toHaveBeenCalledWith("blob:one");
      expect(controller.getState().removed).toBe(true);
      expect(await controller.download("a1")).toBeNull();
      expect(download).toHaveBeenCalledTimes(1);
      expect(await controller.send("hi")).toBe("removed");
      controller.stop();
      vi.restoreAllMocks();
    });
  });
});
