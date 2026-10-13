// Isolated account UI; synthetic identities and quota windows only.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launchVerificationServer } from "./control-omb.ts";
import { fixtureApi, mountPreview, parkUntilSignal, type MountedPreview } from "./testing/preview-fixture.ts";

const fixture = await launchVerificationServer();
let ui: MountedPreview | undefined;
try {
  const api = fixtureApi(fixture.info.url);
  const home = fixture.info.dataDir;
  const cli = join(home, "offline-claude.mjs");
  writeFileSync(cli, `#!/usr/bin/env node
import { basename } from "node:path";
if (process.argv[2] === "auth") {
 console.log(JSON.stringify({ loggedIn: true, email: basename(process.env.CLAUDE_CONFIG_DIR) + "@example.test" }));
} else { await import(${JSON.stringify(pathToFileURL(fileURLToPath(new URL("../server/testing/fake-claude-cli.ts", import.meta.url))).href)}); }
`, { mode: 0o700 });
  const configPath = join(home, "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  for (const id of ["personal", "work"]) {
    const dir = join(home, id); mkdirSync(dir);
    config.instances[id] = { driver: "claudeAgent", displayName: id, config: { cli, configDir: dir }, environment: { HOME: home, USERPROFILE: home } };
  }
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  await api("PUT", "/api/config", { defaultModelSelection: { instanceId: "personal", model: "sonnet" }, profile: { name: "Firaz" } });
  for (const [name, instanceId] of [["bos", "personal"], ["money", "personal"], ["oracle", "work"]]) {
    await api("POST", "/api/bots", { name, modelSelection: { instanceId, model: "sonnet" } });
  }
  const reset = Math.floor(Date.now() / 1000) + 3600;
  const accounts = [
    { provider: "claude", instanceId: "personal", account: "personal", status: "available", fiveHour: { usedPercent: 8, resetsAt: reset }, sevenDay: { usedPercent: 24, resetsAt: reset + 86400 } },
    { provider: "claude", instanceId: "work", account: "work", status: "available", fiveHour: { usedPercent: 12, resetsAt: reset }, sevenDay: { usedPercent: 74, resetsAt: reset + 86400 } },
    { provider: "codex", instanceId: "codex", account: "codex", status: "available", sevenDay: { usedPercent: 77, resetsAt: reset + 86400 } },
  ];
  ui = await mountPreview(fixture, { entry: "/scripts/testing/threads-preview.tsx", route: "/__account-rings.html", title: "Account rings — isolated fixture",
    extraRoutes: [{ path: "/api/provider-usage", handler: (_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ accounts })); } }],
  });
  console.log(JSON.stringify({ ...fixture.info, previewUrl: ui.previewUrl }));
  await parkUntilSignal();
} finally { await ui?.close(); await fixture.close(); }
