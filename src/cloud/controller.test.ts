import { describe, expect, it, vi } from "vitest";
import fixtures from "../../shared/cloud-protocol/fixtures.json";
import type { CloudApi, CloudResult, CloudSession } from "./api";
import { CloudRoomController } from "./controller";
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
  readonly OPEN = 1;
  readyState = 0;
  sent: unknown[] = [];
  private listeners: Record<string, Array<(event: unknown) => void>> = {};
  constructor(readonly url: string) {
    FakeSocket.last = this;
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
});
