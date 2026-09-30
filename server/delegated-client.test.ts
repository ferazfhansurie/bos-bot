import { expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DelegatedClient } from "./delegated-client.ts";
import { homeKey } from "./remote-bot-bridge.ts";
import { RoomHandoffs } from "./room-handoffs.ts";

const link = { homeId: "partner", name: "partner", origin: "https://partner.example.ts.net:8443", token: "omb_sess_fixture", ownerName: "Partner" };
test("old peer gate returns 403 but roster still explains update partner's BOS", async () => {
  const fetcher = async (url: any) => new Response(JSON.stringify(String(url).includes(".well-known") ? { environmentId: "partner" } : { error: "peer route forbidden" }), { status: String(url).includes(".well-known") ? 200 : 403 });
  const client = new DelegatedClient("firaz", () => [link], fetcher as typeof fetch);
  expect((await client.roster("jarvis")).errors.join(" ")).toMatch(/update partner.*BOS/);
});
test("roster is live per caller, credentials stay in transport and revocation excludes cached bots", async () => {
  let granted = true; const calls: Array<{ path: string; headers: Record<string, string> }> = [];
  const client = new DelegatedClient("firaz", () => [link], (async (url: any, init: any) => {
    const path = new URL(url).pathname;
    if (path.includes(".well-known")) return Response.json({ environmentId: "partner", delegatedProtocol: 1 });
    calls.push({ path, headers: init.headers });
    return granted && init.headers["x-bos-grantee-bot"] === "jarvis" ? Response.json({ bots: [{ id: "sol", name: "Sol", title: "Lead", busy: false }] }) : Response.json({ error: "denied" }, { status: 403 });
  }) as typeof fetch);
  const roster = await client.roster("jarvis");
  expect(roster.bots[0].id).toBe(`rb-${homeKey("partner")}-sol`);
  expect(JSON.stringify(roster)).not.toContain(link.token);
  expect((await client.roster("other")).bots).toHaveLength(0);
  granted = false; expect((await client.roster("jarvis")).bots).toHaveLength(0);
  expect(calls[0].headers.authorization).toBe(`Bearer ${link.token}`);
});
test("a delegated result reports and resumes the original Chief exactly once through RoomHandoffs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "delegated-resume-"));
  try {
    let posts = 0; let resumes = 0; const reports: string[] = [];
    const client = new DelegatedClient("firaz", () => [link], (async (url: any, init: any) => {
      if (String(url).includes(".well-known")) return Response.json({ environmentId: "partner", delegatedProtocol: 1 });
      if (init.method === "POST") { posts++; return Response.json({ requestId: "receipt" }); }
      return Response.json({ status: "completed", result: "verified fixture result" });
    }) as typeof fetch);
    const engine = new RoomHandoffs(join(dir, "handoffs.json"), { validate: () => undefined, busy: () => false, changed: () => {},
      report: child => reports.push(child.result), run: async (node, resumed, signal) => {
        if (resumed) { resumes++; return { ok: true, text: "Chief resumed" }; }
        return client.coordinate("jarvis", node.botId, node.id, node.text, signal);
      } });
    const source = { botId: "jarvis", threadId: "chief-chat" };
    engine.enqueue(source, "turn", undefined, { botId: `rb-${homeKey("partner")}-sol`, threadId: "virtual-task" }, "once", "bounded fixture");
    engine.sourceSettled("turn", true);
    for (let i = 0; i < 8; i++) { engine.tick(); await new Promise(resolve => setTimeout(resolve, 0)); }
    expect(posts).toBe(1); expect(resumes).toBe(1); expect(reports).toEqual(["verified fixture result"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("transient safe receipt reads retry with backoff without another POST", async () => {
  vi.useFakeTimers();
  try {
    let posts = 0; let reads = 0;
    const client = new DelegatedClient("firaz", () => [link], (async (url: any, init: any) => {
      if (String(url).includes(".well-known")) return Response.json({ environmentId: "partner", delegatedProtocol: 1 });
      if (init.method === "POST") { posts++; return Response.json({ requestId: "receipt" }); }
      reads++;
      if (reads === 1) throw new TypeError("fixture network failure");
      if (reads === 2) return Response.json({}, { status: 503 });
      return Response.json({ status: "completed", result: "once" });
    }) as typeof fetch);
    const promise = client.coordinate("jarvis", `rb-${homeKey("partner")}-sol`, "once", "bounded", new AbortController().signal);
    const assertion = expect(promise).resolves.toEqual({ ok: true, text: "once" });
    await vi.runAllTimersAsync(); await assertion;
    expect(posts).toBe(1); expect(reads).toBe(3);
  } finally { vi.useRealTimers(); }
});
test("revoked receipt reads stop with the known remote proposal id and no retry", async () => {
  const client = new DelegatedClient("firaz", () => [link], (async (url: any) => String(url).includes(".well-known")
    ? Response.json({ environmentId: "partner", delegatedProtocol: 1 }) : Response.json({}, { status: 403 })) as typeof fetch);
  await expect(client.proposal("jarvis", "partner", "known-review", new AbortController().signal)).rejects.toThrow(/known-review.*do not repeat/i);
});
test("remote review hard cap reports the pending receipt and never calls it an unapplied failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "delegated-cap-")); let now = 0;
  try {
    const engine = new RoomHandoffs(join(dir, "handoffs.json"), { validate: () => undefined, busy: () => false, changed: () => {}, report: () => {}, run: () => new Promise(() => {}) }, () => now);
    const { node } = engine.enqueue({ botId: "jarvis", threadId: "source" }, "turn", undefined,
      { botId: `rb-${homeKey("partner")}-sol`, threadId: "review" }, "review", "review", true, false, "", "known-review");
    engine.sourceSettled("turn", true); engine.tick(); now = 4 * 60 * 60_000; engine.tick();
    expect(node.result).toMatch(/known-review/); expect(node.result).toMatch(/pending|unknown/i); expect(node.result).toMatch(/do not repeat/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("proposal ids are validated before persistence and distinct reviews reuse the same remote reviewer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "delegated-proposal-"));
  try {
    const engine = new RoomHandoffs(join(dir, "handoffs.json"), { validate: () => undefined, busy: () => false, changed: () => {}, report: () => {}, run: async () => ({ ok: true, text: "done" }) });
    const source = { botId: "jarvis", threadId: "source" }; const target = { botId: `rb-${homeKey("partner")}-sol`, threadId: "review" };
    expect(() => engine.enqueue(source, "turn", undefined, target, "bad", "review", true, false, "", "bad/id")).toThrow(/receipt/i);
    const first = engine.enqueue(source, "turn", undefined, target, "one", "review", true, false, "", "review-one");
    first.node.status = "completed";
    expect(() => engine.enqueue(source, "turn", undefined, target, "two", "review", true, false, "", "review-two")).not.toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an uncertain POST is never retried and retains its requestKey", async () => {
  let posts = 0;
  const client = new DelegatedClient("firaz", () => [link], (async (url: any) => {
    if (String(url).includes(".well-known")) return Response.json({ environmentId: "partner", delegatedProtocol: 1 });
    posts++; throw new TypeError("fixture lost reply");
  }) as typeof fetch);
  await expect(client.coordinate("jarvis", `rb-${homeKey("partner")}-sol`, "known-key", "bounded", new AbortController().signal)).rejects.toThrow(/known-key.*do not repeat/i);
  expect(posts).toBe(1);
});
