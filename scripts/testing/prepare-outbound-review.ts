// Explicit disposable ui.json only. The synthetic CLI proposes review cards;
// it has no outbound provider and never submits an external message.
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { fixtureApi } from "./preview-fixture.ts";
import { runControlOmb } from "../control-omb.ts";

const path = process.argv[2];
if (!path || !/\/bosbot-verify-data-[^/]+\/ui\.json$/.test(path)) throw new Error("pass the explicit disposable fixture ui.json path");
const handle = JSON.parse(readFileSync(path, "utf8"));
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(handle.url) || handle.home !== dirname(path)) throw new Error("not an isolated fixture handle");
const root = fileURLToPath(new URL("../..", import.meta.url));
const wrapper = join(handle.home, "outbound-fixture-cli.mjs");
const marker = join(handle.home, "outbound-proposed");
writeFileSync(wrapper, `#!/usr/bin/env node
import { readFileSync, existsSync, writeFileSync } from "node:fs";
const configIndex = process.argv.indexOf("--mcp-config");
if (configIndex >= 0 && !existsSync(${JSON.stringify(marker)})) {
  const config = JSON.parse(readFileSync(process.argv[configIndex + 1], "utf8"));
  const env = config.mcpServers.agents.env;
  const url = env.BOSBOT_HARNESS_URL ?? env.BOS_HARNESS_URL ?? env.OMB_HARNESS_URL;
  if (url !== ${JSON.stringify(handle.url)}) throw new Error("fixture target mismatch");
  const token = env.BOSBOT_COMMS_TOKEN ?? env.BOS_COMMS_TOKEN ?? env.OMB_COMMS_TOKEN;
  for (const recipient of ["review@example.test", "discard@example.test"]) {
    const response = await fetch(url + "/api/internal/outbound-reviews", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + token }, body: JSON.stringify({ content: { channel: "email", recipient, account: "sender@example.test", subject: "synthetic proposal", body: "hello\\n\\nthis exact fixture message must be reviewed before sending." } }) });
    if (!response.ok) throw new Error("synthetic proposal failed: " + response.status);
  }
  writeFileSync(${JSON.stringify(marker)}, "done");
}
await import(${JSON.stringify(pathToFileURL(join(root, "server/testing/fake-claude-cli.ts")).href)});
`, { mode: 0o700 });
const api = fixtureApi(handle.url);
await api("PATCH", "/api/instances/claude", { cli: wrapper });
await runControlOmb(["send", "--url", handle.url, "--bot", handle.botId, "--text", "prepare two synthetic review cards without sending anything outside this fixture"]);
const settled = await runControlOmb(["wait", "--url", handle.url, "--bot", handle.botId, "--timeout", "30"]);
console.log(JSON.stringify({ ok: true, settled }));
