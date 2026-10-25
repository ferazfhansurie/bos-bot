import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AUTO_SKILL_DAILY_ATTEMPTS,
  AUTO_SKILL_DAILY_DRAFTS,
  AUTO_SKILL_MIN_TOOLS,
  AUTO_SKILL_PENDING_DRAFTS,
  AutoSkillLedger,
  autoSkillReadOutside,
  autoSkillDispatchEligible,
  autoSkillGate,
  autoSkillSource,
  buildAutoSkillPrompt,
  isAutoSkillSource,
  parseAutoSkillReply,
  runAutoSkill,
  turnToolCalls,
  turnWroteSkill,
  type AutoSkillWrite,
} from "./auto-skill.ts";
import type { Message } from "./store.ts";

const SKILL = `---
name: weekly-sales-report
description: Pulls last week's orders from the shop and posts the totals to the team sheet.
---

# Weekly sales report

1. Run \`shop orders --since 7d\`.
2. Paste the totals into the team sheet.
`;

const qualifying = {
  enabled: true,
  personStarted: true,
  direct: true,
  ok: true,
  routine: false,
  internal: false,
  askText: "pull last week's sales into the sheet",
  toolCount: AUTO_SKILL_MIN_TOOLS,
  wroteSkill: false,
  canGenerate: true,
};

const dirs: string[] = [];
function ledger(now: () => number = Date.now) {
  const dir = mkdtempSync(join(tmpdir(), "auto-skill-"));
  dirs.push(dir);
  return { path: join(dir, "auto-skills.json"), ledger: new AutoSkillLedger(join(dir, "auto-skills.json"), now) };
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function activity(turnId: string, name: string, extra: Partial<NonNullable<Message["tool"]>> = {}): Message {
  return { id: `${name}-${Math.random()}`, kind: "activity", role: "bot", text: "", at: 10, turnId,
    tool: { name, input: `{"q":"${name}"}`, ...extra } } as Message;
}

describe("auto skill trigger", () => {
  it("runs on a settled, person-started 1:1 turn with enough tool work", () => {
    expect(autoSkillGate(qualifying)).toEqual({ run: true });
  });

  it.each([
    ["off", { enabled: false }],
    ["not-person", { personStarted: false }],
    ["not-direct", { direct: false }],
    ["failed", { ok: false }],
    ["routine", { routine: true }],
    ["internal", { internal: true }],
    ["learn", { askText: "/learn weekly report" }],
    ["few-tools", { toolCount: AUTO_SKILL_MIN_TOOLS - 1 }],
    ["wrote-skill", { wroteSkill: true }],
    ["no-one-shot", { canGenerate: false }],
  ] as const)("skips with reason %s", (reason, change) => {
    expect(autoSkillGate({ ...qualifying, ...change })).toEqual({ run: false, reason });
  });

  it("only counts a turn the person typed into the bot's own thread", () => {
    expect(autoSkillDispatchEligible({})).toBe(true);
    expect(autoSkillDispatchEligible({ commsDepth: 0, unattended: false })).toBe(true);
    for (const turn of [
      { commsDepth: 1 }, // a peer bot asked
      { peerAsk: { from: "bot" } },
      { automationSource: "routine:abc" },
      { automationSource: "webhook:wh_1" },
      { unattended: true, cardContinuation: true }, // whatsapp auto-reply
      { roomContext: "telegram chat" },
      { compactOnly: true },
      { modRequest: true },
      { member: { id: "m1" } },
      { sharedContext: true },
      { cardContinuation: true },
      { sender: { name: "guest" } }, // someone other than the owner
      { coordination: { id: "c1" } },
      { resumed: true }, // replayed after sign-in, provenance gone
    ]) {
      expect(autoSkillDispatchEligible(turn)).toBe(false);
    }
  });

  it("reads only this turn's real tool calls", () => {
    const messages = [
      ...Array.from({ length: 3 }, (_, i) => activity("t1", `bash-${i}`)),
      activity("t1", "setup-mcp", { setup: true }),
      activity("t1", "error:timeout"),
      activity("t0", "older-turn"),
      { id: "u", kind: "text", role: "user", text: "hi", at: 1, turnId: "t1" } as Message,
    ];
    expect(turnToolCalls(messages, "t1").map((call) => call.name)).toEqual(["bash-0", "bash-1", "bash-2"]);
  });

  it("notices a turn that already wrote a skill", () => {
    expect(turnWroteSkill([activity("t1", "mcp__agents__skill_manage")], "t1", 0)).toBe(true);
    const card = { id: "c", kind: "message", role: "assistant", text: "", at: 50, card: { skillRequest: { id: "s" } } } as unknown as Message;
    expect(turnWroteSkill([card], "t1", 40)).toBe(true);
    expect(turnWroteSkill([card], "t1", 60)).toBe(false);
    expect(turnWroteSkill([activity("t1", "Bash")], "t1", 0)).toBe(false);
  });
});

describe("auto skill distill", () => {
  it("frames the run as data and leaves tool output out", () => {
    const prompt = buildAutoSkillPrompt({
      ask: "do the report",
      tools: [{ name: "Bash", input: "shop orders --since 7d" }],
      reply: "done",
      skills: [{ name: "existing-one", description: "already here" }],
    });
    expect(prompt).toMatch(/SKIP/);
    expect(prompt).toContain("existing-one");
    expect(prompt).toContain("shop orders --since 7d");
    expect(prompt.indexOf("BEGIN RUN")).toBeLessThan(prompt.indexOf("do the report"));
  });

  it("redacts secrets in tool arguments before the model sees them", () => {
    const prompt = buildAutoSkillPrompt({ ask: "x", tools: [{ name: "Bash", input: "curl -H 'Authorization: Bearer sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789'" }], reply: "", skills: [] });
    expect(prompt).not.toContain("sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789");
  });

  it("parses SKIP, a fenced skill, and rejects bad or taken drafts", () => {
    expect(parseAutoSkillReply("SKIP", [])).toEqual({ kind: "skip" });
    expect(parseAutoSkillReply("  skip — one-off lookup", [])).toEqual({ kind: "skip" });
    const fenced = parseAutoSkillReply("```markdown\n" + SKILL.trim() + "\n```", []);
    expect(fenced).toMatchObject({ kind: "skill", name: "weekly-sales-report" });
    expect(parseAutoSkillReply("Here is a skill:\n" + SKILL, [])).toEqual({ kind: "invalid", reason: "no frontmatter" });
    expect(parseAutoSkillReply(SKILL.replace("weekly-sales-report", "Weekly Sales!"), [])).toEqual({ kind: "invalid", reason: "bad name" });
    expect(parseAutoSkillReply("---\nname: a-b\ndescription: x\n---\n", [])).toEqual({ kind: "invalid", reason: "empty body" });
    expect(parseAutoSkillReply(SKILL, ["weekly-sales-report"])).toEqual({ kind: "invalid", reason: "name taken" });
  });

  it("marks auto skills as learned, so /learn can still revise them", () => {
    expect(autoSkillSource("thread-1")).toBe("learn:auto:thread-1");
    expect(isAutoSkillSource("learn:auto:thread-1")).toBe(true);
    expect(isAutoSkillSource("learn:thread-1")).toBe(false);
  });
});

describe("autoSkillDispatchEligible lines", () => {
  it("checks every line the turn answers, drained queue lines too", () => {
    const ownerId = "owner-1";
    expect(autoSkillDispatchEligible({ ownerId, lines: [{}, { sender: { id: ownerId } }] })).toBe(true);
    expect(autoSkillDispatchEligible({ ownerId, lines: [{}, { peerAsk: { from: "bot" } }] })).toBe(false);
    expect(autoSkillDispatchEligible({ ownerId, lines: [{ sender: { id: "actor-2" } }] })).toBe(false);
    expect(autoSkillDispatchEligible({ ownerId, lines: [{ sender: {} }] })).toBe(false);
    expect(autoSkillDispatchEligible({ lines: [{ sender: { id: "owner-1" } }] })).toBe(false);
  });
});

describe("autoSkillReadOutside", () => {
  it("flags runs that read the web, a browser page or a connected app", () => {
    expect(autoSkillReadOutside([{ name: "Bash", input: "ls -la" }, { name: "Edit" }])).toBe(false);
    for (const tool of [
      { name: "WebFetch" },
      { name: "WebSearch" },
      { name: "mcp__browser__agent_browser_read" },
      { name: "mcp__computer__browser_navigate" },
      { name: "mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL" },
      { name: "Bash", input: '{"command":"curl -s example.com"}' },
      { name: "Bash", input: '{"command":"python3 x.py https://example.com"}' },
    ]) {
      expect(autoSkillReadOutside([{ name: "Edit" }, tool])).toBe(true);
    }
  });
});

describe("runAutoSkill", () => {
  const run = { ask: "do the report", tools: [{ name: "Bash", input: "shop orders" }], reply: "done" };

  function deps(reply: string, write: (draft: { name: string }) => AutoSkillWrite, extra: Partial<Parameters<typeof runAutoSkill>[0]> = {}) {
    return { botId: "bot-1", generateText: vi.fn(async () => reply), skills: () => [], write: vi.fn(write), ledger: ledger().ledger, ...extra };
  }

  it("stops at SKIP without writing", async () => {
    const d = deps("SKIP", () => ({ state: "applied", name: "x" }));
    expect(await runAutoSkill(d, run)).toEqual({ state: "skip" });
    expect(d.write).not.toHaveBeenCalled();
  });

  it("drops a draft whose name collides with an installed or staged skill", async () => {
    const installed = deps(SKILL, () => ({ state: "applied", name: "x" }), { skills: () => [{ name: "weekly-sales-report", description: "" }] });
    expect(await runAutoSkill(installed, run)).toEqual({ state: "invalid", reason: "name taken" });
    const staged = deps(SKILL, () => ({ state: "pending", name: "x" }), { stagedNames: () => ["weekly-sales-report"] });
    expect(await runAutoSkill(staged, run)).toEqual({ state: "invalid", reason: "name taken" });
    expect(installed.write).not.toHaveBeenCalled();
    expect(staged.write).not.toHaveBeenCalled();
  });

  it("passes through applied (full access) and pending (review card) writes", async () => {
    const applied = deps(SKILL, (draft) => ({ state: "applied", name: draft.name }));
    expect(await runAutoSkill(applied, run)).toEqual({ state: "applied", name: "weekly-sales-report" });
    const pending = deps(SKILL, (draft) => ({ state: "pending", name: draft.name }));
    expect(await runAutoSkill(pending, run)).toEqual({ state: "pending", name: "weekly-sales-report" });
    expect(pending.write).toHaveBeenCalledWith(expect.objectContaining({ skillMd: SKILL }));
  });

  it("does not draft while auto drafts already wait on cards", async () => {
    const d = deps(SKILL, (draft) => ({ state: "pending", name: draft.name }), { pendingDrafts: () => AUTO_SKILL_PENDING_DRAFTS });
    expect(await runAutoSkill(d, run)).toEqual({ state: "capped", reason: "drafts waiting" });
    expect(d.generateText).not.toHaveBeenCalled();
    const below = deps(SKILL, (draft) => ({ state: "pending", name: draft.name }), { pendingDrafts: () => AUTO_SKILL_PENDING_DRAFTS - 1 });
    expect(await runAutoSkill(below, run)).toEqual({ state: "pending", name: "weekly-sales-report" });
  });

  it("does not call the model once the workspace is over its spend limit", async () => {
    const d = deps(SKILL, (draft) => ({ state: "pending", name: draft.name }), { budget: () => { throw new Error("spend cap"); } });
    expect(await runAutoSkill(d, run)).toEqual({ state: "capped", reason: "spend limit" });
    expect(d.generateText).not.toHaveBeenCalled();
  });

  it("caps drafts per bot per day, then attempts", async () => {
    const shared = ledger();
    for (let i = 0; i < AUTO_SKILL_DAILY_DRAFTS; i++) {
      const d = deps(SKILL.replace("weekly-sales-report", `report-${i}`), (draft) => ({ state: "pending", name: draft.name }), { ledger: shared.ledger });
      expect((await runAutoSkill(d, run)).state).toBe("pending");
    }
    const over = deps(SKILL.replace("weekly-sales-report", "report-x"), () => ({ state: "pending", name: "x" }), { ledger: shared.ledger });
    expect(await runAutoSkill(over, run)).toEqual({ state: "capped" });
    expect(over.generateText).not.toHaveBeenCalled();
    // another bot has its own budget
    const other = deps(SKILL, (draft) => ({ state: "pending", name: draft.name }), { ledger: shared.ledger, botId: "bot-2" });
    expect((await runAutoSkill(other, run)).state).toBe("pending");
    // the counts survive a restart, and the file stays private
    expect(new AutoSkillLedger(shared.path).canDraft("bot-1")).toBe(false);
    expect(statSync(shared.path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(shared.path, "utf8"))["bot-1"].drafts).toBe(AUTO_SKILL_DAILY_DRAFTS);

    const skips = ledger();
    for (let i = 0; i < AUTO_SKILL_DAILY_ATTEMPTS; i++) {
      expect(await runAutoSkill(deps("SKIP", () => ({ state: "applied", name: "x" }), { ledger: skips.ledger }), run)).toEqual({ state: "skip" });
    }
    const tired = deps("SKIP", () => ({ state: "applied", name: "x" }), { ledger: skips.ledger });
    expect(await runAutoSkill(tired, run)).toEqual({ state: "capped" });
    expect(tired.generateText).not.toHaveBeenCalled();
  });

  it("resets the caps the next local day", async () => {
    let now = new Date(2026, 9, 25, 23, 0).getTime();
    const day = ledger(() => now);
    for (let i = 0; i < AUTO_SKILL_DAILY_DRAFTS; i++) day.ledger.noteDraft("bot-1");
    expect(day.ledger.canAttempt("bot-1")).toBe(false);
    now = new Date(2026, 9, 26, 0, 5).getTime();
    expect(day.ledger.canAttempt("bot-1")).toBe(true);
  });

  it("gives up on a one-shot that hangs, without writing", async () => {
    const d = deps("", () => ({ state: "applied", name: "x" }), {
      generateText: vi.fn((_prompt: string, options?: { signal?: AbortSignal }) => new Promise<string>((_, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })),
      timeoutMs: 20,
    });
    expect(await runAutoSkill(d, run)).toMatchObject({ state: "error" });
    expect(d.write).not.toHaveBeenCalled();
  });

  it("does not count a failed write against the daily drafts", async () => {
    const shared = ledger();
    const d = deps(SKILL, () => ({ state: "failed", error: "thread gone" }), { ledger: shared.ledger });
    expect(await runAutoSkill(d, run)).toEqual({ state: "failed", error: "thread gone" });
    expect(JSON.parse(readFileSync(shared.path, "utf8"))["bot-1"].drafts).toBe(0);
  });
});
