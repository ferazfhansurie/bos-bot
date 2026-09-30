import { expect, test } from "vitest";
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
