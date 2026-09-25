// Workspace-wide permission defaults: a new bot may start at the level the
// operator chose once, instead of the historical hard-coded Ask, and an
// engine switch may carry that level when the destination implements it.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR, defaultApprovalMode, keepApprovalAcrossModelSwitch, loadConfig, parseConfigPatch } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { Store } from "./store.ts";
import { approvalModeFor, modelSwitchNeedsAsk, supportsApprovalMode } from "../shared/approval-mode.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
const writeConfig = (config: unknown) => {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(join(DATA_DIR, "config.json"), JSON.stringify(config));
};

describe("approval defaults", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("reads the workspace default from config and keeps Ask as the fallback", () => {
    expect(defaultApprovalMode({})).toBe("ask");
    expect(keepApprovalAcrossModelSwitch({})).toBe(false);
    writeConfig({ approvals: { defaultMode: "full", keepAcrossModelSwitch: true } });
    const cfg = loadConfig();
    expect(defaultApprovalMode(cfg)).toBe("full");
    expect(keepApprovalAcrossModelSwitch(cfg)).toBe(true);
    // A nonsense level must not widen anything.
    expect(defaultApprovalMode({ approvals: { defaultMode: "root" as never } })).toBe("ask");
  });

  it("accepts the section in a settings patch", () => {
    const patch = parseConfigPatch({ approvals: { defaultMode: "full", keepAcrossModelSwitch: true } });
    expect(patch.approvals).toEqual({ defaultMode: "full", keepAcrossModelSwitch: true });
    expect(() => parseConfigPatch({ approvals: { defaultMode: "root" } })).toThrow();
  });

  it("starts a new bot and its first thread at the configured level", () => {
    writeConfig({ approvals: { defaultMode: "full" } });
    const store = new Store(selection);
    const bot = store.createBot({}, { seedMessages: false });
    expect(bot.approvalMode).toBe("full");
    expect(store.taskByThread(bot.id, bot.threadId)!.approvalMode).toBe("full");
    expect(approvalModeFor(store.projectBotForTask(bot.id, bot.threadId)!)).toBe("full");
  });

  it("keeps Ask for new bots when nothing is configured, and never hands out Custom", () => {
    const store = new Store(selection);
    expect(approvalModeFor(store.createBot({}, { seedMessages: false }))).toBe("ask");
    writeConfig({ approvals: { defaultMode: "custom" } });
    const fresh = new Store(selection);
    expect(approvalModeFor(fresh.createBot({}, { seedMessages: false }))).toBe("ask");
  });

  it("adopts the default for a bot that never chose a level, and leaves an explicit choice alone", () => {
    const store = new Store(selection);
    const adopting = store.createBot({ name: "Adopting" }, { seedMessages: false });
    const deliberate = store.createBot({ name: "Deliberate" }, { seedMessages: false });
    const file = join(DATA_DIR, "bots.json");
    const saved = JSON.parse(readFileSync(file, "utf8"));
    const bots = Array.isArray(saved) ? saved : saved.bots;
    for (const bot of bots) {
      if (bot.id === adopting.id) { delete bot.approvalMode; delete bot.autoApprove; }
      if (bot.id === deliberate.id) { bot.approvalMode = "ask"; }
    }
    writeFileSync(file, JSON.stringify(saved));
    writeConfig({ approvals: { defaultMode: "full" } });
    const reloaded = new Store(selection);
    expect(reloaded.bot(adopting.id)!.approvalMode).toBe("full");
    expect(reloaded.bot(deliberate.id)!.approvalMode).toBe("ask");
    // The adoption is persisted once, not recomputed from a stale default.
    writeConfig({});
    expect(new Store(selection).bot(adopting.id)!.approvalMode).toBe("full");
  });

  it("only carries a level across engines the destination can express", () => {
    // Guard for the server's switch rule: Claude → Codex both implement Full,
    // while a destination without Full must still fall back to Ask.
    expect(modelSwitchNeedsAsk("full", "claudeAgent", "codex")).toBe(true);
    expect(supportsApprovalMode("codex", "full")).toBe(true);
    expect(supportsApprovalMode("pi", "full")).toBe(false);
  });
});
