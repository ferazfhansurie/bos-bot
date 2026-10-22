// The current picture on the real path: a turn records the bot's one-shot,
// the picture is built from the MEMORY.md on disk after the debounce, and the
// next turn's assembled system prompt carries it instead of the raw file.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { compatEnv } from "../electron/branding-env.cjs";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

it("loads the current picture on the turn after memory changes", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "omb-memory-picture-"));
  const arrangement = join(scratch, "arrangement.json");
  writeFileSync(arrangement, JSON.stringify({
    groups: [{ heading: "garden", entries: [1] }, { heading: "open items", entries: [2] }],
    stale: [{ entry: 2, due: "2020-01-08" }],
  }));
  const fixture = await launchVerificationServer({ ...compatEnv, FAKE_CLAUDE_TEXT_FILE: arrangement });
  const env = { OPENMAUSBOT_URL: fixture.info.url };
  const systemPrompt = () => {
    try {
      // SAFETY: the fake CLI writes exactly this shape; a missing or partial file reads as no dump yet
      return (JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")) as { systemPrompt?: string }).systemPrompt ?? "";
    } catch {
      return "";
    }
  };
  try {
    // SAFETY: control-omb returns the created bot record under `bot`
    const { bot } = await runControlOmb(["new-bot", "--name", "Gardener"], { env }) as { bot: { id: string } };
    const workspace = join(fixture.info.dataDir, "workspaces", bot.id);
    await runControlOmb(["send", "--bot", bot.id, "--text", "hello"], { env });
    await runControlOmb(["wait", "--bot", bot.id, "--timeout", "30"], { env });
    writeFileSync(join(workspace, "MEMORY.md"),
      "- 2020-01-01 · from chat \"garden\" · the fixture garden is watered on Mondays\n" +
      "- 2020-01-02 · the shed repaint waits on the owner's ok (by 2020-01-08)\n");
    // the hand edit is seen on the next turn: raw now, picture scheduled
    await runControlOmb(["send", "--bot", bot.id, "--text", "what day is watering?"], { env });
    await runControlOmb(["wait", "--bot", bot.id, "--timeout", "30"], { env });
    expect(systemPrompt()).toContain("Your memory (MEMORY.md):");
    await expect.poll(() => existsSync(join(workspace, ".memory-summary.json")), { timeout: 30_000, interval: 250 }).toBe(true);
    await runControlOmb(["send", "--bot", bot.id, "--text", "and the shed?"], { env });
    await runControlOmb(["wait", "--bot", bot.id, "--timeout", "30"], { env });
    const prompt = systemPrompt();
    expect(prompt).toContain("Your memory, current picture");
    expect(prompt).toContain("## garden\n- 2020-01-01 · the fixture garden is watered on Mondays");
    expect(prompt).toContain("(by 2020-01-08) (stale? due 2020-01-08)");
    expect(prompt).not.toContain("Your memory (MEMORY.md):");
  } finally {
    await fixture.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}, 120_000);
