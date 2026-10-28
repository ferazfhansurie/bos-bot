import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

it("starts a new thread for every run, hidden while it works and shown once it has something to say", async () => {
  const fixture = await launchVerificationServer();
  const evidence: unknown[] = [{ fixture: fixture.info }];
  let broker: Socket | undefined;
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method, headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBe(status);
    if (method !== "GET") evidence.push({ method, path, body, status: response.status, result: value });
    return value;
  };
  const control = (args: string[]) => runControlOmb([...args, "--url", fixture.info.url]);
  const runState = async (id: string) => (await api("GET", "/api/routines")).runs.find((run: any) => run.id === id);
  const messages = async (id: string) => (await api("GET", `/api/threads/${id}/messages?limit=100`)).messages as any[];
  try {
    expect((await control(["doctor"]) as any).ok).toBe(true);
    const { bot } = await control(["new-bot", "--name", "Results fixture"]) as any;
    const originalThread = (await api("GET", "/api/bots")).bots.find((candidate: any) => candidate.id === bot.id).threadId;
    const { routine } = await api("POST", "/api/routines", {
      name: "Persistent report", prompt: "Report this run's state.", botId: bot.id, enabled: false,
      schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 },
    }, 201);
    const completed: any[] = [];
    for (let index = 0; index < 2; index++) {
      const { run } = await api("POST", `/api/routines/${routine.id}/run`, undefined, 201);
      await expect.poll(async () => (await runState(run.id))?.status, { timeout: 15_000 }).toBe("completed");
      const finished = await runState(run.id);
      completed.push(finished);
      const dump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"));
      expect(dump.argv).not.toContain("--resume");
      expect(JSON.stringify(dump.prompt)).not.toContain("hello from fake claude");
      evidence.push(await control(["wait", "--bot", bot.id, "--task", finished.threadId]));
      evidence.push(await control(["messages", "--bot", bot.id, "--task", finished.threadId, "--limit", "10"]));
    }
    // Each run is its own new thread: nothing reuses an old chat or a
    // standing results thread.
    expect(completed[0].threadId).not.toBe(completed[1].threadId);
    for (const run of completed) expect(run.resultsThreadId).toBeUndefined();
    const cards: any[] = [];
    for (const run of completed) {
      const transcript = await messages(run.threadId);
      expect(transcript.some((message) => message.role === "bot" && message.text === "hello from fake claude")).toBe(true);
      cards.push(...transcript.filter((message) => message.routineRun));
    }
    expect(cards).toHaveLength(0);
    const currentBot = async () => (await api("GET", "/api/bots")).bots.find((candidate: any) => candidate.id === bot.id);
    const savedBot = await currentBot();
    expect(savedBot.threadId).toBe(originalThread);
    expect(savedBot.tasks.some((task: any) => /· Results$/.test(task.title))).toBe(false);
    // the main chat plus one thread per run
    expect(savedBot.tasks.filter((task: any) => !task.routineRunId)).toHaveLength(3);
    for (const run of completed) expect(savedBot.tasks.find((task: any) => task.threadId === run.threadId))
      .toMatchObject({ unread: true, autoApprove: false, approvalMode: "ask" });
    expect((await messages(originalThread)).some((message) => message.routineRun)).toBe(false);

    // A run thread stays a normal conversation the person can keep using.
    await api("POST", `/api/bots/${bot.id}/messages`, { threadId: completed[0].threadId, text: "Explain that completed report." }, 202);
    evidence.push(await control(["wait", "--bot", bot.id, "--task", completed[0].threadId]));
    await api("POST", `/api/routine-runs/${completed[0].id}/seen`);
    expect((await currentBot()).tasks.find((task: any) => task.threadId === completed[0].threadId).routineRunId).toBeUndefined();

    const gate = join(fixture.info.dataDir, "results-finish");
    const wrapper = join(fixture.info.dataDir, "results-slow.mjs");
    writeFileSync(wrapper, [
      "#!/usr/bin/env node",
      'process.env.FAKE_CLAUDE_MODE = "slow";',
      `process.env.FAKE_CLAUDE_SLOW_FINISH_GATE = ${JSON.stringify(gate)};`,
      `await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/testing/fake-claude-cli.ts")).href)});`,
    ].join("\n"), { mode: 0o700 });
    await api("PATCH", "/api/instances/claude", { cli: wrapper });
    const { run: pending } = await api("POST", `/api/routines/${routine.id}/run`, undefined, 201);
    await expect.poll(async () => (await runState(pending.id))?.status, { timeout: 15_000 }).toBe("running");
    const active = await runState(pending.id);
    // While it works, the new thread stays out of the sidebar.
    expect((await currentBot()).tasks.find((task: any) => task.threadId === active.threadId)).toMatchObject({ routineRunId: pending.id, unread: false });
    await expect.poll(() => {
      if (!existsSync(fixture.fixtureDumpPath)) return false;
      return JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).mcpConfig?.mcpServers?.agents?.env?.OMB_THREAD_ID === active.threadId;
    }, { timeout: 15_000 }).toBe(true);
    const launched = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"));
    const socketPath = launched.mcpConfig.mcpServers.ogb.args.at(-1);
    broker = connect(socketPath);
    broker.on("error", () => {});
    await new Promise<void>((resolve, reject) => { broker!.once("connect", resolve); broker!.once("error", reject); });
    broker.write(JSON.stringify({ t: "ask", id: "results-approval", kind: "permission", tool: "Bash", input: { command: "echo fixture-approval" } }) + "\n");
    await expect.poll(async () => (await runState(pending.id))?.status, { timeout: 15_000 }).toBe("waiting");
    // A run that needs the person shows up as its own unread thread, with the approval in it.
    const shown = (await currentBot()).tasks.find((task: any) => task.threadId === active.threadId);
    expect(shown.routineRunId).toBeUndefined();
    expect(shown.unread).toBe(true);
    const approval = (await messages(active.threadId)).find((message) => message.card && !message.card.answered);
    expect(approval?.card.tool).toBe("Bash");
    await api("POST", `/api/bots/${bot.id}/respond`, { threadId: active.threadId, requestId: approval.card.requestId, behavior: "deny" });
    writeFileSync(gate, "complete the isolated turn");
    await expect.poll(async () => (await runState(pending.id))?.status, { timeout: 15_000 }).toBe("completed");
    evidence.push({ cards, final: await api("GET", "/api/routines"), bot: await currentBot(), shown });
  } finally {
    broker?.destroy();
    const evidencePath = `${fixture.info.logPath}.results.json`;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    console.info(JSON.stringify({ logPath: fixture.info.logPath, evidencePath }));
    await fixture.close();
  }
}, 90_000);
// branding compatibility (electron/branding-compat.json): environment-aliases: legacy launchd/systemd and provider subprocess environment labels stay accepted; the central resolver always prefers the new spelling
