import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/state/store";
import {
  UPDATE_STEPS,
  applyUpdate,
  checkForUpdate,
  isUpdateRunning,
  noteUpdateFrame,
  pollUpdateStatus,
  setUpdateTransport,
  updateNotice,
  useBosUpdate,
  type UpdateStatus,
  type UpdateTransport,
} from "./bos-update";

// read the module's view without React: useSyncExternalStore is just a hook
// over subscribe/getSnapshot, so drive the module through its exports
vi.mock("react", async (actual) => ({
  ...(await actual<typeof import("react")>()),
  useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get(),
}));

const READY: UpdateStatus = {
  state: "ready",
  current: { version: "1.2.0", sha: "2d83ba23aaaa" },
  candidate: { version: "1.3.0", sha: "abcdef123456", branch: "prod" },
  busyTurns: [{ botId: "b1", threadId: "t1" }],
};

function mock(overrides: Partial<UpdateTransport> = {}): UpdateTransport {
  return {
    status: vi.fn(async () => READY),
    check: vi.fn(async () => ({ current: READY.current, candidate: READY.candidate })),
    apply: vi.fn(async () => ({ updateId: "u1" })),
    restart: vi.fn(async () => undefined),
    ...overrides,
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  setUpdateTransport(null);
  vi.useRealTimers();
});

describe("bos-update", () => {
  it("reads the staged candidate from status", async () => {
    setUpdateTransport(mock());
    await pollUpdateStatus();
    expect(useBosUpdate().state).toBe("ready");
    expect(useBosUpdate().status?.candidate?.version).toBe("1.3.0");
  });

  it("goes quiet when the server has no updater (404)", async () => {
    setUpdateTransport(mock({ status: vi.fn(async () => { throw new ApiError("not found", 404); }) }));
    await pollUpdateStatus();
    expect(useBosUpdate().status).toBeNull();
  });

  it("apply starts the run; a 409 says another update owns the lock", async () => {
    const transport = mock({ apply: vi.fn(async () => { throw new ApiError("busy", 409); }) });
    setUpdateTransport(transport);
    await pollUpdateStatus();
    await applyUpdate(false);
    expect(transport.apply).toHaveBeenCalledWith(false);
    expect(useBosUpdate().error).toBe("Another update is already running.");
    expect(useBosUpdate().pending).toBeNull();
  });

  it("a successful apply moves to draining and ignores a second click", async () => {
    const transport = mock();
    setUpdateTransport(transport);
    await pollUpdateStatus();
    await applyUpdate(false);
    await applyUpdate(false);
    expect(transport.apply).toHaveBeenCalledTimes(1);
    expect(useBosUpdate().state).toBe("draining");
  });

  it("a press while a run is going is a no-op and keeps the live step", async () => {
    const transport = mock({
      status: vi.fn(async () => ({ ...READY, state: "idle" as const })),
      apply: vi.fn(async () => ({ updateId: "u1", inProgress: true })),
    });
    setUpdateTransport(transport);
    await pollUpdateStatus();
    noteUpdateFrame({ kind: "update.state", state: "building", updateId: "u1" });
    await applyUpdate(false);
    expect(transport.apply).not.toHaveBeenCalled();
    expect(useBosUpdate().state).toBe("building");
  });

  it("check lights the button only when the guard allows a candidate", async () => {
    const transport = mock({
      status: vi.fn(async () => ({ state: "idle" as const, current: READY.current, busyTurns: [] })),
      check: vi.fn(async () => ({ current: READY.current, reason: "already on the newest prod build" })),
    });
    setUpdateTransport(transport);
    await pollUpdateStatus();
    await checkForUpdate();
    expect(useBosUpdate().state).toBe("idle");
    expect(useBosUpdate().status?.candidate).toBeUndefined();
    expect(useBosUpdate().status?.reason).toBe("already on the newest prod build");
    // a later poll that does not repeat the reason keeps it
    await pollUpdateStatus();
    expect(useBosUpdate().status?.reason).toBe("already on the newest prod build");
    (transport.check as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ current: READY.current, candidate: READY.candidate });
    await checkForUpdate();
    expect(useBosUpdate().state).toBe("ready");
    expect(useBosUpdate().status?.candidate?.version).toBe("1.3.0");
  });

  it("walks every step in order", () => {
    expect(UPDATE_STEPS).toEqual(["draining", "checkpointing", "stopping", "building", "applying", "relaunching", "verifying"]);
    for (const step of UPDATE_STEPS) expect(isUpdateRunning(step)).toBe(true);
    for (const settled of ["idle", "ready", "updated", "done", "rolled_back", "failed"] as const) expect(isUpdateRunning(settled)).toBe(false);
  });

  it("frames advance the step; losing the server mid-run reads as relaunching", async () => {
    const transport = mock();
    setUpdateTransport(transport);
    await pollUpdateStatus();
    noteUpdateFrame({ kind: "update.state", state: "applying", updateId: "u1" });
    expect(useBosUpdate().state).toBe("applying");
    (transport.status as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await pollUpdateStatus();
    expect(useBosUpdate().state).toBe("relaunching");
    expect(useBosUpdate().offline).toBe(true);
  });

  it("an unreachable server while idle is not an update in progress", async () => {
    setUpdateTransport(mock({ status: vi.fn(async () => { throw new TypeError("Failed to fetch"); }) }));
    await pollUpdateStatus();
    expect(useBosUpdate().offline).toBe(false);
    expect(isUpdateRunning(useBosUpdate().state)).toBe(false);
  });

  it("names the post-restart result", () => {
    const from = READY.current;
    const to = { version: "1.3.0", sha: "abcdef123456" };
    const done = updateNotice({ ...READY, state: "idle", candidate: undefined, current: to, lastResult: { state: "updated", at: 1, from, to } });
    expect(done?.title).toBe("Updated to 1.3.0");
    expect(done?.detail).toContain("1.2.0 → 1.3.0");
    expect(updateNotice({ ...READY, state: "idle", current: to, lastResult: { state: "done", at: 1 } })?.title).toBe("Updated to 1.3.0");
    const back = updateNotice({ ...READY, state: "idle", lastResult: { state: "rolled_back", at: 2, from, to, detail: "health check failed on 8799" } });
    expect(back?.title).toBe("Update failed, rolled back to 1.2.0");
    expect(back?.detail).toBe("health check failed on 8799");
    expect(back?.tone).toBe("warn");
    const failed = updateNotice({ ...READY, state: "idle", lastResult: { state: "failed", at: 3, from, to, detail: "build failed" } });
    expect(failed?.title).toBe("Update failed, still on 1.2.0");
    expect(updateNotice({ ...READY, lastResult: undefined })).toBeNull();
  });
});
