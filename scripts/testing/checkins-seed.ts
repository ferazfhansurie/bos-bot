// Seeds a `ui launch` fixture (launched with --mode slow and
// FAKE_CLAUDE_SLOW_FINISH_GATE) with 3.0 check-in items through the real
// propose_item MCP handler, using credentials captured from a running chief
// turn. Never touches the user's app: the handle names the fixture.
//   node --experimental-strip-types scripts/testing/checkins-seed.ts HANDLE.json GATE_PATH
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { fixtureApi } from "./preview-fixture.ts";
import { waitForExit } from "../../server/testing/cleanup.ts";

const [handlePath, gate] = process.argv.slice(2);
if (!handlePath || !gate) throw new Error("usage: checkins-seed.ts HANDLE.json GATE_PATH");
const root = fileURLToPath(new URL("../..", import.meta.url));
const handle = JSON.parse(readFileSync(handlePath, "utf8"));
const url: string = handle.url;
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(url)) throw new Error(`refusing a non-fixture url ${url}`);
const api = fixtureApi(url, { headers: { origin: url } });
const dump = join(handle.dataDir ?? handle.home, "fake-claude-dump.json");

async function until(check: () => boolean | Promise<boolean>, what: string) {
  const deadline = Date.now() + 20_000;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

await api("PATCH", "/api/config", { features: { v3: true }, profile: { name: "Firaz" } });
const chief = (await api("GET", "/api/bots")).bots.find((bot: { name: string }) => bot.name === "Pepper");
await api("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true });
const { bot: helper } = await api("POST", "/api/bots", { name: "Miso" });
// The broke item traces to its own thread on the helper, so the two stay apart.
const { task: seoTask } = await api("POST", `/api/bots/${helper.id}/tasks`, { title: "seo loop" });

// A slow chief turn keeps its agents capability alive while we call the tools.
await api("POST", `/api/bots/${chief.id}/messages`, { text: "morning check-in" });
await until(() => existsSync(dump), "the chief turn's MCP config");
const agents = JSON.parse(readFileSync(dump, "utf8")).mcpConfig.mcpServers.agents;
const proxy = spawn(process.execPath, ["--experimental-strip-types", join(root, "server/drivers/agents-proxy.ts")], {
  env: { HOME: dirname(dump), USERPROFILE: dirname(dump), PATH: dirname(process.execPath), ...agents.env },
  stdio: ["pipe", "pipe", "inherit"],
});
const pending = new Map<number, (response: any) => void>();
createInterface({ input: proxy.stdout }).on("line", (line) => {
  try { const response = JSON.parse(line); pending.get(response.id)?.(response); pending.delete(response.id); } catch { /* not ours */ }
});
let nextId = 1;
const call = (name: string, args: unknown) => new Promise<any>((resolve, reject) => {
  const id = nextId++;
  const timer = setTimeout(() => reject(new Error(`${name} timed out`)), 15_000);
  pending.set(id, (response) => { clearTimeout(timer); resolve(response); });
  proxy.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\n");
});

const results: unknown[] = [];
try {
  const items = [
    { kind: "decide", title: "drop the rm49 tier from the pricing page?", why: "3 of the last 4 trials picked rm99; rm49 only adds a support load.",
      sources: [{ type: "thread", ref: helper.threadId, label: "#pricing test" }],
      draft: "hey, we're simplifying pricing: rm99 covers everything rm49 did, and your first month moves over free." },
    { kind: "broke", title: "seo loop stopped after two failed runs", why: "the search console token expired at 3pm; nothing has posted since.",
      sources: [{ type: "thread", ref: seoTask.threadId, label: "#seo loop" }],
      plan: "refresh the search console token, rerun the loop once and check the post went out." },
    { kind: "did", title: "today screen landed on prod", why: "check-ins now show on the mac and the phone; you install it from settings.",
      sources: [{ type: "commit", ref: "6600704bb", label: "6600704" }] },
  ];
  for (const args of items) {
    const response = await call("propose_item", args);
    if (response.error || response.result?.isError) throw new Error(JSON.stringify(response));
    results.push({ tool: "propose_item", title: args.title, result: response.result?.content?.[0]?.text });
  }
  // The same source in the same state is the same item.
  const again = await call("propose_item", items[0]);
  results.push({ tool: "propose_item (again)", result: again.result?.content?.[0]?.text });
  results.push({ tool: "list_items", result: (await call("list_items", {})).result?.content?.[0]?.text });
} finally {
  await waitForExit(proxy, { signal: "SIGTERM" });
  writeFileSync(gate, "seeded");
}
const snapshot = await api("GET", "/api/checkins");
console.log(JSON.stringify({ ok: true, chiefId: chief.id, helperId: helper.id, results, snapshot }, null, 2));
