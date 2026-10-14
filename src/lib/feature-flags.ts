import { t } from "./i18n";

export interface FeatureFlagConfig {
  features?: { skillAuthoring?: boolean; showToolCalls?: boolean; browser?: boolean; sharedComputers?: boolean; claudeUserMcp?: boolean };
  browserEngine?: { kind: "engine" | "unavailable"; reason?: string; installable?: boolean; installing?: boolean; installError?: string };
}

/** Whether this server can give a bot a browser: the agent-browser engine is
 * installed there. Servers from before the engine report nothing: no browser. */
export function browserAvailable(config: FeatureFlagConfig | null | undefined): boolean {
  return config?.browserEngine?.kind === "engine";
}

/** Why a bot cannot have a browser right now, in the user's words. */
export function browserUnavailableReason(config: FeatureFlagConfig | null | undefined): string {
  const engine = config?.browserEngine;
  if (engine?.kind === "unavailable" && engine.installable) return t("browser.notInstalled");
  if (engine?.kind === "unavailable" && engine.reason) return engine.reason;
  return t("browser.noEngine");
}

/** Bots may draft skills (the Verify card's Save as skill, /learn,
 * skill_manage) for the user's review. On unless a saved config switched it
 * off — the same rule as the server's skillAuthoringEnabled. */
export function skillAuthoringEnabled(config: FeatureFlagConfig | null | undefined): boolean {
  return config?.features?.skillAuthoring !== false;
}

/** The built-in browser is on for the workspace unless a saved config
 * explicitly switched it off; there is no Settings toggle any more. Each bot
 * still has its own switch, and the engine installs only when asked. Mirrors
 * the server's builtInBrowserEnabled. */
export function builtInBrowserEnabled(config: FeatureFlagConfig | null | undefined): boolean {
  return config?.features?.browser !== false;
}

/** Tool-run chips in the transcript. On unless switched off from a room's
 * header; there is no Settings toggle any more. */
export function showToolCallsEnabled(config: FeatureFlagConfig | null | undefined): boolean {
  return config?.features?.showToolCalls !== false;
}

/** Opt-in computer sharing — lending this desktop's folders, terminal or
 * computer control to a connected workspace. Off unless this server was
 * explicitly switched on in its config.json; there is no Settings toggle, so
 * the controls simply are not offered. */
export function sharedComputersEnabled(config: FeatureFlagConfig | null | undefined): boolean {
  return config?.features?.sharedComputers === true;
}

/** Claude bots also see the MCP servers of this machine's own Claude Code
 * setup (Plugins → MCP servers). Off by default — every extra tool costs
 * tokens on each message — and mirrors the server's claudeUserMcpEnabled. */
export function claudeUserMcpEnabled(config: FeatureFlagConfig | null | undefined): boolean {
  return config?.features?.claudeUserMcp === true;
}
