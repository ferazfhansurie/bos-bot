import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AppState, Bot } from "@/state/store";

const fixture = vi.hoisted(() => ({ state: {} as Partial<AppState>, dispatch: vi.fn() }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: { ...original.initialState, ...fixture.state }, dispatch: fixture.dispatch }) };
});

import { initialState } from "@/state/store";
import { groupJobs, type JobInboxItem } from "@/lib/job-inbox";
import { JobCard, JobInboxBody, JobInboxNavRow, JobInboxPage } from "./JobInbox";

const bots = [
  { id: "lead", name: "bos", threadId: "t1" },
  { id: "helper", name: "ui", threadId: "h1" },
] as unknown as Bot[];
const state = { ...initialState, bots } as AppState;

const job = (overrides: Partial<JobInboxItem> = {}): JobInboxItem => ({
  botId: "lead", threadId: "t1", revision: 1, outcome: "Ship the job inbox", state: "moving",
  steps: [
    { id: "a", ownerBotId: "lead", action: "write model", status: "done", dependsOn: [], evidence: "21 checks passed" },
    { id: "b", ownerBotId: "helper", action: "build desktop view", status: "ready", dependsOn: ["a"] },
  ],
  results: [{ stepId: "a", ownerBotId: "lead", evidence: "21 checks passed", source: "owner-reported" }],
  ...overrides,
});

const body = (inbox: { items: JobInboxItem[] } | null | undefined, onOpen = vi.fn()) =>
  renderToStaticMarkup(createElement(JobInboxBody, { inbox, groups: groupJobs(inbox?.items ?? []), state, onOpen }));

describe("job inbox page", () => {
  it("shows loading, unsupported and empty states", () => {
    expect(body(undefined)).toContain("data-jobs-loading");
    expect(body(null)).toContain("Update the OpenMausBot server to see jobs here.");
    expect(body({ items: [] })).toContain("No jobs yet");
  });

  it("shows outcome, state, lead and helper owners, next work and owner-attributed results", () => {
    const html = body({ items: [job(), job({ threadId: "t2", state: "needs-you", reason: "Approve the install", outcome: "Install 1.8" })] });
    expect(html.indexOf("Install 1.8")).toBeLessThan(html.indexOf("Ship the job inbox"));
    expect(html).toContain('data-jobs-group="needs-you"');
    expect(html).toContain("Approve the install");
    expect(html).toContain("Lead: bos");
    expect(html).toContain("Helpers: ui");
    expect(html).toContain("1/2 steps done");
    expect(html).toMatch(/Next · <\/span><span[^>]*>ui: <\/span>build desktop view/);
    expect(html).toMatch(/Reported by bos: <\/span>21 checks passed/);
    expect(html).toContain("Results are as each owner reported them.");
  });

  it("names unknown owners without inventing them", () => {
    const html = renderToStaticMarkup(createElement(JobCard, { item: job({ botId: "gone" }), state, onOpen: vi.fn() }));
    expect(html).toContain("Lead: Unknown bot");
  });

  it("keeps Needs me reachable from the page and renders the nav row", () => {
    fixture.state = { bots };
    expect(renderToStaticMarkup(createElement(JobInboxPage))).toContain("data-jobs-needs-me");
    fixture.state = { activeView: "jobs" };
    const row = renderToStaticMarkup(createElement(JobInboxNavRow, { density: "comfortable" }));
    expect(row).toContain("data-sidebar-jobs");
    expect(row).toContain("bg-raised text-ink");
  });
});
