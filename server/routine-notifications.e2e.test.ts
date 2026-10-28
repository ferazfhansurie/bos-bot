import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

it("enforces saved notification choices on real runs, report cards, unread and SSE without losing logs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bos-routine-policies-"));
  const fixture = await launchVerificationServer({ ...process.env,
    FAKE_CLAUDE_REPLIES: JSON.stringify(["ordinary check", "ordinary check", "ordinary check", "IMPORTANT_UPDATE: build is broken", "NOTHING_TO_REPORT"]),
    FAKE_CLAUDE_REPLY_STATE: join(dir, "reply-state"),
  });
  const api = async (method: string, path: string, body?: unknown): Promise<any> => {
    const response = await fetch(fixture.info.url + path, { method, headers: { "content-type": "application/json", origin: fixture.info.url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json(); expect(response.ok, JSON.stringify(result)).toBe(true); return result;
  };
  const abort = new AbortController();
  const response = await fetch(fixture.info.url + "/api/events?screens=off", { signal: abort.signal });
  const frames: any[] = []; let buffered = "";
  const reading = (async () => { const reader = response.body!.getReader(); try { for (;;) { const part = await reader.read(); if (part.done) break; buffered += new TextDecoder().decode(part.value); const lines = buffered.split("\n"); buffered = lines.pop()!; for (const line of lines) if (line.startsWith("data: ")) frames.push(JSON.parse(line.slice(6))); } } catch { /* owned stream closes */ } })();
  try {
    const { bot } = await runControlOmb(["new-bot", "--name", "Policy fixture", "--url", fixture.info.url]) as any;
    const cases = [ ["all", true], ["important", false], ["failures", false], ["important", true], ["all", false] ] as const;
    for (const [index, [policy, surfaced]] of cases.entries()) {
      const { routine } = await api("POST", "/api/routines", { name: `policy ${index}`, botId: bot.id, prompt: "Report state", notificationPolicy: policy, enabled: false, schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 } });
      expect(routine.notificationPolicy).toBe(policy);
      const before = frames.length;
      const { run } = await api("POST", `/api/routines/${routine.id}/run`);
      const state = async () => (await api("GET", "/api/routines")).runs.find((candidate: any) => candidate.id === run.id);
      await expect.poll(async () => (await state())?.status, { timeout: 15_000 }).toBe("completed");
      const done = await state();
      expect(done.notificationPolicy).toBe(policy);
      const currentBot = (await api("GET", "/api/bots")).bots.find((candidate: any) => candidate.id === bot.id);
      // Each run is its own thread: a surfaced run shows up as a new unread
      // thread holding the reply; anything else stays hidden.
      const execution = currentBot.tasks.find((task: any) => task.threadId === done.threadId);
      expect(Boolean(execution?.unread)).toBe(surfaced);
      expect(execution?.routineRunId).toBe(surfaced ? undefined : run.id);
      const messages = (await api("GET", `/api/threads/${done.threadId}/messages?limit=100`)).messages;
      expect(messages.some((message: any) => message.routineRun)).toBe(false);
      if (surfaced) expect(messages.filter((message: any) => message.role === "bot" && message.kind === "text").at(-1)?.text).toBe(done.output);
      if (index < 3) expect(done.output).toBe("ordinary check");
      if (index === 3) { expect(done.output).toBe("build is broken"); expect(done.important).toBe(true); expect(JSON.stringify(JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).prompt)).toContain("IMPORTANT_UPDATE:"); }
      await expect.poll(() => frames.slice(before).some(frame => frame.kind === "routine.run" && frame.run?.id === run.id && frame.run.status === "completed")).toBe(true);
      const notifications = frames.slice(before).filter(frame => frame.kind === "notify" && frame.notification?.threadId === done.threadId && frame.notification.kind === "done");
      expect(notifications.length).toBe(surfaced ? 1 : 0);
    }
  } finally { abort.abort(); await reading; await fixture.close(); rmSync(dir, { recursive: true, force: true }); }
}, 90_000);
