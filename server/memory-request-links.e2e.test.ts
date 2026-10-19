import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

it("corrects answer-linked memory and opens only the exact pending request through isolated HTTP", async () => {
  const fixture = await launchVerificationServer();
  const url = fixture.info.url;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${url}${path}`, { method, headers: { "content-type": "application/json", origin: url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    // Fixture-only JSON view; each field is checked by assertions below.
    return { status: response.status, body: await response.json() as any };
  };
  try {
    const bots = (await api("GET", "/api/bots")).body.bots;
    const bot = bots[0];
    await api("PUT", `/api/bots/${bot.id}/memory/file`, { path: "MEMORY.md", text: "- fixture coffee: black\n- fixture tea: green\n" });
    const wrapper = join(fixture.info.dataDir, "answer-source-fixture.mjs");
    writeFileSync(wrapper, [
      "#!/usr/bin/env node",
      `import { existsSync } from "node:fs";`,
      `if (existsSync(${JSON.stringify(join(fixture.info.dataDir, "pending-plan.json"))})) process.env.FAKE_CLAUDE_ROOM_PLAN = ${JSON.stringify(join(fixture.info.dataDir, "pending-plan.json"))};`,
      `if (process.argv.includes("stream-json")) {`,
      `  const { recordRetrievedMemory } = await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/memory-sources.ts")).href)});`,
      `  const source = recordRetrievedMemory(${JSON.stringify(bot.id)}, ${JSON.stringify(bot.threadId)}, "MEMORY.md", "coffee");`,
      `  process.env.FAKE_CLAUDE_REPLIES = JSON.stringify(["your coffee is black [memory-source:" + source.id + "]"]);`,
      `}`,
      `await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/testing/fake-claude-cli.ts")).href)});`,
    ].join("\n"), { mode: 0o700 });
    expect((await api("PATCH", "/api/instances/claude", { cli: wrapper })).status).toBe(200);
    await runControlOmb(["send", "--bot", bot.id, "--text", "What is my fixture coffee?", "--url", url]);
    expect(await runControlOmb(["wait", "--bot", bot.id, "--timeout", "30", "--url", url])).toMatchObject({ status: "settled" });
    const page = (await api("GET", `/api/threads/${bot.threadId}/messages`)).body;
    const answer = page.messages.find((message: any) => message.text?.includes("[memory-source:"));
    expect(answer).toBeDefined();
    const endpoint = `/api/bots/${bot.id}/answers/${answer.id}/memory-sources?threadId=${bot.threadId}`;
    const sources = (await api("GET", endpoint)).body.sources;
    expect(sources).toMatchObject([{ path: "MEMORY.md", text: "- fixture coffee: black" }]);
    const source = sources[0];
    expect((await api("PATCH", endpoint, { sourceId: source.id, expectedHash: source.hash, replacement: "- fixture coffee: oat milk" })).status).toBe(200);
    expect((await api("GET", `/api/bots/${bot.id}/memory/file?path=MEMORY.md`)).body.text).toBe("- fixture coffee: oat milk\n- fixture tea: green\n");
    expect((await api("PATCH", endpoint, { sourceId: source.id, expectedHash: source.hash, replacement: "" })).status).toBe(409);
    expect((await api("GET", `/api/bots/${bot.id}/memory/journal`)).body.entries.some((entry: any) => entry.via === "answer-source")).toBe(true);

    writeFileSync(join(fixture.info.dataDir, "pending-plan.json"), JSON.stringify({ [bot.id]: { turns: [{ steps: [{ tool: "propose_profile", arguments: { title: "Fixture proposed title", reason: "Fixture requires review." } }], reply: "Review the fixture proposal." }] } }));
    await runControlOmb(["send", "--bot", bot.id, "--text", "Prepare a fixture profile proposal for my review.", "--url", url]);
    expect(await runControlOmb(["wait", "--bot", bot.id, "--timeout", "30", "--url", url])).toMatchObject({ status: "needs-user" });
    const pending = (await api("GET", `/api/threads/${bot.threadId}/messages`)).body.messages;
    const card = pending.find((message: any) => message.card?.profileRequest && !message.card.answered && !message.card.dismissed);
    expect(card).toBeDefined();
    const target = `/api/bots/${bot.id}/request-continuation?${new URLSearchParams({ threadId: bot.threadId, messageId: card.id, requestId: card.card.requestId })}`;
    const linked = await api("GET", target);
    expect(linked.status).toBe(200);
    const link = new URL(linked.body.url);
    expect([...link.searchParams.keys()].sort()).toEqual(["bot", "home", "message", "request", "thread"]);
    expect((await api("GET", `${target}&home=wrong-home`)).status).toBe(404);
    expect((await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: card.card.requestId, behavior: "deny" })).status).toBe(200);
    expect((await api("GET", target)).status).toBe(410);
    console.log(JSON.stringify({ ok: true, exactAnswerSource: true, guardedCorrection: true, journal: true, pendingRequest: true, settledRefused: true, fixture: fixture.info }));
  } finally { await fixture.close(); }
}, 90_000);
