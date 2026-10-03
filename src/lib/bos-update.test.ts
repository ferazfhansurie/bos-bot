import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/state/store";
import {
  applyUpdate,
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
  candidate: { version: "1.3.0", sha: "abcdef123456", stagedAt: 1_700_000_000_000 },
  busyTurns: [{ botId: "b1", threadId: "t1" }],
};

function mock(overrides: Partial<UpdateTransport> = {}): UpdateTransport {
  return {
    status: vi.fn(async () => READY),
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

  it("a successful apply moves to checkpointing and ignores a second click", async () => {
    const transport = mock();
    setUpdateTransport(transport);
    await pollUpdateStatus();
    await applyUpdate(true);
    await applyUpdate(true);
    expect(transport.apply).toHaveBeenCalledTimes(1);
    expect(useBosUpdate().state).toBe("checkpointing");
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

  it("names the post-relaunch result", () => {
    const done = updateNotice({ ...READY, state: "idle", candidate: undefined, current: { version: "1.3.0", sha: "abcdef123456" }, lastResult: { state: "done", at: 1 } });
    expect(done?.title).toBe("Updated to 1.3.0");
    const back = updateNotice({ ...READY, state: "idle", lastResult: { state: "rolled_back", at: 2, detail: "health check failed on 8799", rollback: true } });
    expect(back?.title).toBe("Rolled back: health check failed on 8799");
    expect(back?.tone).toBe("warn");
    expect(updateNotice({ ...READY, lastResult: undefined })).toBeNull();
  });
});
