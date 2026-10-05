import { describe, expect, it, vi } from "vitest";

import { ApiError, initialState, reducer } from "@/state/store";
import {
  fetchJobInbox,
  groupJobs,
  jobNextStep,
  jobOwners,
  jobRefreshKey,
  normalizeJobInbox,
  openJobThread,
  startJobInboxRead,
  type JobInboxItem,
} from "./job-inbox";

const job = (overrides: Partial<JobInboxItem> = {}): JobInboxItem => ({
  botId: "lead", threadId: "t1", revision: 1, outcome: "Ship the inbox", state: "moving",
  steps: [
    { id: "a", ownerBotId: "lead", action: "write model", status: "done", dependsOn: [], evidence: "21 checks" },
    { id: "b", ownerBotId: "helper", action: "build view", status: "ready", dependsOn: ["a"] },
    { id: "c", ownerBotId: "other", action: "verify", status: "waiting", dependsOn: ["b"] },
  ],
  results: [{ stepId: "a", ownerBotId: "lead", evidence: "21 checks", source: "owner-reported" }],
  ...overrides,
});

describe("normalizeJobInbox", () => {
  it("keeps well-formed rows, drops malformed ones and duplicate plans", () => {
    const result = normalizeJobInbox({
      items: [
        job(),
        { botId: "x", threadId: "t", state: "nope" },
        { threadId: "t2", state: "ready" },
        job({ outcome: "duplicate" }),
        job({ threadId: "t2", state: "completed" }),
      ],
    });
    expect(result?.items.map((item) => [item.threadId, item.outcome])).toEqual([["t1", "Ship the inbox"], ["t2", "Ship the inbox"]]);
  });

  it("drops malformed steps and evidence-free results, and labels evidence owner-reported", () => {
    const result = normalizeJobInbox({ items: [{
      botId: "lead", threadId: "t1", revision: 2, outcome: "x", state: "completed",
      steps: [{ id: "a", ownerBotId: "lead", action: "do", status: "done", dependsOn: ["z", 3] }, { id: "b", status: "maybe" }],
      results: [{ stepId: "a", ownerBotId: "lead", evidence: "proof", source: "verified" }, { stepId: "b", ownerBotId: "lead", evidence: "  " }],
    }] });
    expect(result?.items[0].steps).toEqual([{ id: "a", ownerBotId: "lead", action: "do", status: "done", dependsOn: ["z"] }]);
    expect(result?.items[0].results).toEqual([{ stepId: "a", ownerBotId: "lead", evidence: "proof", source: "owner-reported" }]);
  });

  it("reads anything without an items list as no endpoint", () => {
    expect(normalizeJobInbox("<!doctype html>")).toBeNull();
    expect(normalizeJobInbox({})).toBeNull();
  });
});

describe("fetchJobInbox", () => {
  it("reads GET /api/jobs with the caller's abort signal", async () => {
    const request = vi.fn(async () => ({ items: [job()] }));
    const controller = new AbortController();
    const result = await fetchJobInbox(controller.signal, request);
    expect(request).toHaveBeenCalledWith("/api/jobs", { signal: controller.signal });
    expect(result?.items).toHaveLength(1);
  });

  it("reports a server without the endpoint as null and rethrows real failures", async () => {
    await expect(fetchJobInbox(undefined, async () => { throw new ApiError("nf", 404); })).resolves.toBeNull();
    await expect(fetchJobInbox(undefined, async () => { throw new ApiError("forbidden", 403); })).rejects.toThrow("forbidden");
  });
});

describe("job helpers", () => {
  it("groups most urgent first", () => {
    const groups = groupJobs([job({ threadId: "1", state: "completed" }), job({ threadId: "2", state: "needs-you" }), job({ threadId: "3", state: "moving" })]);
    expect(groups.map((group) => group.state)).toEqual(["needs-you", "moving", "completed"]);
  });

  it("names the lead and distinct helpers in plan order", () => {
    expect(jobOwners(job())).toEqual({ leadBotId: "lead", helperBotIds: ["helper", "other"] });
  });

  it("picks the ready step whose dependencies are done, else the blocked one", () => {
    expect(jobNextStep(job())?.id).toBe("b");
    const blocked = job({ steps: [
      { id: "a", ownerBotId: "lead", action: "x", status: "ready", dependsOn: ["b"] },
      { id: "b", ownerBotId: "helper", action: "y", status: "blocked", dependsOn: [], reason: "disk" },
    ] });
    expect(jobNextStep(blocked)?.id).toBe("b");
    expect(jobNextStep(job({ steps: [job().steps[0]] }))).toBeUndefined();
  });

  it("changes its refresh key when a task starts or a thread appears", () => {
    const base = { bots: [{ id: "a", tasks: [{ threadId: "t1" }] }], groups: [], inboxCount: 0 };
    const key = jobRefreshKey(base);
    expect(jobRefreshKey({ ...base, bots: [{ id: "a", tasks: [{ threadId: "t1", busy: true }] }] })).not.toBe(key);
    expect(jobRefreshKey({ ...base, bots: [{ id: "a", tasks: [{ threadId: "t1" }, { threadId: "t2" }] }] })).not.toBe(key);
    expect(jobRefreshKey({ ...base })).toBe(key);
  });

  it("opens the jobs view over any open panel", () => {
    const next = reducer({ ...initialState, settingsOpen: true, pluginsOpen: true }, { type: "showJobs" });
    expect(next.activeView).toBe("jobs");
    expect(next.settingsOpen).toBe(false);
    expect(next.pluginsOpen).toBe(false);
  });
});

describe("startJobInboxRead", () => {
  const handlers = () => ({ onData: vi.fn(), onError: vi.fn(), onSettled: vi.fn() });

  it("applies a settled read", async () => {
    const h = handlers();
    startJobInboxRead(h, async () => ({ items: [job()] }));
    await vi.waitFor(() => expect(h.onSettled).toHaveBeenCalled());
    expect(h.onData).toHaveBeenCalledWith({ items: [job()] });
    expect(h.onError).not.toHaveBeenCalled();
  });

  it("aborts the request on stop and drops its late answer", async () => {
    const h = handlers();
    let signal: AbortSignal | undefined;
    let finish: (value: { items: JobInboxItem[] }) => void = () => {};
    const stop = startJobInboxRead(h, (s) => { signal = s; return new Promise((resolve) => { finish = resolve; }); });
    stop();
    expect(signal?.aborted).toBe(true);
    finish({ items: [job()] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.onData).not.toHaveBeenCalled();
    expect(h.onSettled).not.toHaveBeenCalled();
  });

  it("reports a failed read", async () => {
    const h = handlers();
    startJobInboxRead(h, async () => { throw new ApiError("boom", 500); });
    await vi.waitFor(() => expect(h.onError).toHaveBeenCalledWith("boom"));
  });
});

describe("openJobThread", () => {
  it("switches to the job's existing thread", () => {
    const dispatch = vi.fn();
    const state = { ...initialState, bots: [{ id: "lead", name: "bos", threadId: "main", tasks: [{ threadId: "main" }, { threadId: "t1" }] }] } as never;
    expect(openJobThread(dispatch, { botId: "lead", threadId: "t1" }, state)).toBe(true);
    const types = dispatch.mock.calls.map(([action]) => action.type);
    expect(types).toContain("revealThread");
    expect(types.some((type: string) => /new|create/i.test(type))).toBe(false);
  });

  it("opens a room's thread through the room", () => {
    const dispatch = vi.fn();
    const state = { ...initialState, bots: [], groups: [{ id: "room", threadId: "rt", tasks: [{ threadId: "t1" }] }] } as never;
    expect(openJobThread(dispatch, { botId: "lead", threadId: "t1" }, state)).toBe(true);
    expect(dispatch).toHaveBeenCalledWith({ type: "switchGroupTask", groupId: "room", threadId: "t1" });
  });

  it("never creates a thread the client does not hold", () => {
    const dispatch = vi.fn();
    const state = { ...initialState, bots: [{ id: "lead", name: "bos", threadId: "main", tasks: [{ threadId: "main" }] }] } as never;
    expect(openJobThread(dispatch, { botId: "lead", threadId: "gone" }, state)).toBe(false);
    expect(dispatch).toHaveBeenCalledWith({ type: "notice", notice: { kind: "thread-gone", botName: "bos" } });
    expect(dispatch.mock.calls.some(([action]) => /new|create/i.test(action.type))).toBe(false);
  });
});
