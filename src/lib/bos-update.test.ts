import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/state/store";
import {
  UPDATE_STEPS,
  applyUpdate,
  checkForUpdate,
  availableCandidate,
  isRunningBuild,
  isUpdateRunning,
  isUpdateSuccess,
  noteUpdateFrame,
  pollUpdateStatus,
  setUpdateTransport,
  shortVersion,
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
    restart: vi.fn(async () => ({ updateId: "r1" })),
    progress: vi.fn(async () => ({ state: "building" as const, log: [] })),
    ...overrides,
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  setUpdateTransport(null);
  vi.useRealTimers();
});

describe("running-build comparison", () => {
  const full = "a014552b64ef7b32265c5df04fd0d71a8f3d94c8";
  const running = { version: "1.9.2", sha: full };
  it("same sha is never an update, whatever the +build metadata says", () => {
    expect(isRunningBuild({ version: "1.9.2+a014552b", sha: full }, running)).toBe(true);
    expect(isRunningBuild({ version: "1.9.2+a014552b", sha: "a014552b" }, running)).toBe(true);
    expect(isRunningBuild({ version: "1.9.2+beefcafe", sha: "beefcafe00000000" }, running)).toBe(false);
    expect(isRunningBuild({ version: "1.9.3", sha: "unknown" }, { version: "1.9.2", sha: "unknown" })).toBe(false);
    expect(isRunningBuild({ version: "1.9.2", sha: "unknown" }, { version: "1.9.2", sha: "unknown" })).toBe(true);
    expect(shortVersion("1.9.2+a014552b")).toBe("1.9.2");
  });

  it("availableCandidate drops the running build and keeps a newer one", () => {
    const same = { current: running, candidate: { version: "1.9.2+a014552b", sha: full } };
    expect(availableCandidate(same)).toBeUndefined();
    const newer = { current: running, candidate: { version: "1.9.3+beefcafe", sha: "beefcafe00000000" } };
    expect(availableCandidate(newer)).toBe(newer.candidate);
  });

  it("a poll or check that returns the running build as candidate settles idle", async () => {
    const stale: UpdateStatus = { state: "ready", current: running, candidate: { version: "1.9.2+a014552b", sha: full, branch: "prod" }, busyTurns: [] };
    setUpdateTransport(mock({ status: vi.fn(async () => stale), check: vi.fn(async () => ({ current: running, candidate: stale.candidate })) }));
    await pollUpdateStatus();
    expect(useBosUpdate().state).toBe("idle");
    expect(useBosUpdate().status?.candidate).toBeUndefined();
    await checkForUpdate();
    expect(useBosUpdate().state).toBe("idle");
    expect(useBosUpdate().status?.candidate).toBeUndefined();
  });
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

  it("a 409 on apply shows the server's line and the button works again", async () => {
    const refusal = "install refused: downgrade refused: running 2d83ba23 is not an ancestor of candidate da37ae2a";
    const transport = mock({ apply: vi.fn(async () => { throw new ApiError(refusal, 409); }) });
    setUpdateTransport(transport);
    await pollUpdateStatus();
    await applyUpdate(false);
    expect(transport.apply).toHaveBeenCalledWith(false);
    expect(useBosUpdate().error).toBe(refusal);
    expect(useBosUpdate().pending).toBeNull();
    expect(useBosUpdate().state).toBe("ready");
    (transport.apply as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ updateId: "u2" });
    await applyUpdate(false);
    expect(transport.apply).toHaveBeenCalledTimes(2);
    expect(useBosUpdate().error).toBeNull();
    expect(useBosUpdate().state).toBe("building");
  });

  it("a successful apply starts at building and ignores a second click", async () => {
    const transport = mock();
    setUpdateTransport(transport);
    await pollUpdateStatus();
    await applyUpdate(false);
    await applyUpdate(false);
    expect(transport.apply).toHaveBeenCalledTimes(1);
    expect(useBosUpdate().state).toBe("building");
  });

  it("a press another window already started answers 200 inProgress: no second job, the poll owns the step", async () => {
    const transport = mock({ apply: vi.fn(async () => ({ updateId: "u1", inProgress: true })) });
    setUpdateTransport(transport);
    await pollUpdateStatus();
    await applyUpdate(false);
    expect(transport.apply).toHaveBeenCalledTimes(1);
    expect(useBosUpdate().pending).toBeNull();
    expect(useBosUpdate().error).toBeNull();
    (transport.status as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ...READY, state: "draining" });
    await pollUpdateStatus();
    expect(useBosUpdate().state).toBe("draining");
  });

  it("building reads the build output tail from /progress", async () => {
    const transport = mock({
      status: vi.fn(async () => ({ ...READY, state: "building" as const })),
      progress: vi.fn(async () => ({ state: "building" as const, updateId: "u1", log: ["archiving feedface", "vite built"] })),
    });
    setUpdateTransport(transport);
    await pollUpdateStatus();
    expect(transport.progress).toHaveBeenCalled();
    expect(useBosUpdate().log).toEqual(["archiving feedface", "vite built"]);
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
    expect(UPDATE_STEPS).toEqual(["building", "draining", "checkpointing", "stopping", "applying", "relaunching", "verifying"]);
    for (const step of UPDATE_STEPS) expect(isUpdateRunning(step)).toBe(true);
    for (const settled of ["idle", "ready", "done", "rolled_back", "failed"] as const) expect(isUpdateRunning(settled)).toBe(false);
    expect(isUpdateSuccess("done")).toBe(true);
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
    const done = updateNotice({ ...READY, state: "idle", candidate: undefined, current: to, lastResult: { state: "done", at: 1, from, to } });
    expect(done?.title).toBe("Updated to 1.3.0");
    expect(done?.detail).toContain("1.2.0 → 1.3.0");
    expect(updateNotice({ ...READY, state: "idle", current: to, lastResult: { state: "done", at: 1 } })?.title).toBe("Updated to 1.3.0");
    // pipe's engine: after a rollback or failure to == from, attempted is the build that did not make it
    const back = updateNotice({ ...READY, state: "idle", lastResult: { state: "rolled_back", at: 2, from, to: from, attempted: to, detail: "health check failed on 8799" } });
    expect(back?.title).toBe("Update failed, rolled back to 1.2.0");
    expect(back?.detail).toBe("1.3.0 · health check failed on 8799");
    expect(back?.tone).toBe("warn");
    // the version comes from lastResult.to, not the live status
    const elsewhere = updateNotice({ ...READY, state: "idle", current: { version: "9.9.9", sha: "x" }, lastResult: { state: "rolled_back", at: 2, from, to: from, attempted: to } });
    expect(elsewhere?.title).toBe("Update failed, rolled back to 1.2.0");
    const failed = updateNotice({ ...READY, state: "idle", lastResult: { state: "failed", at: 3, from, to: from, attempted: to, detail: "build failed" } });
    expect(failed?.title).toBe("Update failed, still on 1.2.0");
    expect(failed?.detail).toBe("1.3.0 · build failed");
    expect(updateNotice({ ...READY, lastResult: undefined })).toBeNull();
  });
});
