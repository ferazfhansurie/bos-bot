import path from "node:path";
import { mkdirSync } from "node:fs";
// A dedicated child-process home isolates CLI providers that have no config-dir flag.
// This never changes the operating-system account or the launching shell.
export function stagingServerEnvironment(environment, dataDir) {
  const env = { ...environment };
  for (const key of Object.keys(env)) {
    if (/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key) || /^(?:OMB_|OGB_|OPENMAUSBOT_|CLAUDE_|CODEX_|OPENCODE_|GROK_|KIMI_|HERMES_|FACTORY_|PI_)/.test(key)) delete env[key];
  }
  const home = path.join(dataDir, "provider-home");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return { ...env, HOME: home, USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local/share"),
    XDG_CACHE_HOME: path.join(home, ".cache"), LOCALAPPDATA: path.join(home, "AppData/Local"),
    CODEX_HOME: path.join(home, ".codex"), CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    OMB_DISABLE_LEGACY_MIGRATION: "1" };
}
