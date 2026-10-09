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
import type { JobInboxItem } from "@/lib/job-inbox";
import type { InboxItem } from "@/lib/inbox";
import { JobDetail, JobInboxBody, JobInboxNavRow, JobInboxPage } from "./JobInbox";

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
  results: [{ stepId: "a", ownerBotId: "lead", evidence: "landed 0a8ca146f", source: "owner-reported" }],
  ...overrides,
});

const ask = (overrides: Partial<InboxItem> = {}): InboxItem => ({
  id: "approval:1", kind: "waiting-on-you", botId: "lead", threadId: "t1", title: "Allow Bash", preview: "rm -rf build",
  at: Date.now(), messageId: "m1", requestId: "r1", approval: true, ...overrides,
});

const body = (jobs: { items: JobInboxItem[] } | null | undefined, asks: InboxItem[] | undefined = [], expanded: string[] = []) =>
  renderToStaticMarkup(createElement(JobInboxBody, {
    jobs, asks, state, busy: new Set<string>(), expanded: new Set(expanded),
    onToggle: vi.fn(), onOpen: vi.fn(), onOpenAsk: vi.fn(), onAnswer: vi.fn(),
  }));

const section = (html: string, marker: string) => {
  const start = html.indexOf(marker);
  const end = html.indexOf("</section>", start);
  return start < 0 ? "" : html.slice(start, end);
};

describe("jobs page", () => {
  it("shows loading, unsupported and empty states under your move", () => {
    expect(body(undefined)).toContain("data-jobs-loading");
    expect(body(null)).toContain("Update the BOS Bot server to see jobs here.");
    const empty = body({ items: [] });
    expect(empty).toContain("No jobs yet");
    expect(empty).toContain("Nothing on you");
  });

  it("puts only live asks and jobs on the person in your move, answerable in place", () => {
    const html = body(
      { items: [job(), job({ threadId: "t2", state: "needs-you", reason: "Approve the install", outcome: "Install 1.8" })] },
      [ask()],
    );
    const yours = section(html, "data-jobs-your-move");
    expect(yours).toContain("Your move · 2");
    expect(yours).toContain("Allow Bash");
    expect(yours).toContain("Allow once");
    expect(yours).toContain("Install 1.8");
    expect(yours).toContain("Approve the install");
    expect(yours).not.toContain("Ship the job inbox");
    expect(yours).not.toContain("Nothing on you");
  });

  it("shows each job as one title line and one next line, no shas or reports", () => {
    const html = body({ items: [
      job({ outcome: "launch prep: api renames, ship batches 1.9.3 + notarization" }),
      job({ threadId: "t3", state: "blocked", steps: [
        { id: "x", ownerBotId: "helper", action: "install 84f685aa2", status: "blocked", dependsOn: [], reason: "package of 84f685aa2 is at code signing" },
      ] }),
      job({ threadId: "t4", state: "waiting" }),
    ] });
    const moving = section(html, 'data-jobs-group="moving"');
    expect(moving).toContain("Moving · 2");
    expect(moving).toMatch(/data-job-title[^>]*>launch prep</);
    expect(moving).toContain('data-job-status="running"');
    expect(moving).toContain("waiting on ui");
    expect(moving).toMatch(/next: <span[^>]*>build desktop view</);
    // a blocked job waits on a gate the person clears, with its reason as the line
    const yours = section(html, "data-jobs-your-move");
    expect(yours).toContain(">blocked<");
    expect(yours).toContain("package of is at code signing");
    expect(html).not.toMatch(/84f685aa2|0a8ca146f|Reported by|data-job-detail/);
  });

  it("folds done and paused jobs to a count", () => {
    const html = body({ items: [job({ threadId: "d1", state: "completed" }), job({ threadId: "d2", state: "completed" }), job({ threadId: "p1", state: "paused" })] });
    expect(html).toContain('<details data-jobs-group="done"');
    expect(html).not.toContain('open=""');
    expect(html).toContain("Done · 2");
    expect(html).toContain("Paused · 1");
    expect(html).not.toContain('data-jobs-group="moving"');
  });

  it("opens today's full detail on tap, with owner-attributed results and steps", () => {
    const html = body({ items: [job()] }, [], ["lead:t1"]);
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("data-job-detail");
    expect(html).toContain("Lead: bos");
    expect(html).toContain("Helpers: ui");
    expect(html).toContain("1/2 steps done");
    expect(html).toMatch(/Reported by bos: <\/span>landed 0a8ca146f/);
    expect(html).toContain("Results are as each owner reported them.");
    expect(html).toContain("data-job-open");
  });

  it("names unknown owners without inventing them", () => {
    const html = renderToStaticMarkup(createElement(JobDetail, { item: job({ botId: "gone" }), state, onOpen: vi.fn() }));
    expect(html).toContain("Lead: Unknown bot");
  });

  it("drops the separate needs me link and renders the nav row", () => {
    fixture.state = { bots };
    expect(renderToStaticMarkup(createElement(JobInboxPage))).not.toContain("data-jobs-needs-me");
    fixture.state = { activeView: "jobs" };
    const row = renderToStaticMarkup(createElement(JobInboxNavRow, { density: "comfortable" }));
    expect(row).toContain("data-sidebar-jobs");
    expect(row).toContain("bg-raised text-ink");
    // the badge waits for the your-move count, never the raw inbox count
    fixture.state = { inboxCount: 7 };
    expect(renderToStaticMarkup(createElement(JobInboxNavRow, { density: "comfortable" }))).not.toContain("data-jobs-badge");
  });
});
