// 3.0: plain words. With 3.0 on, the English catalog says "apps" where it
// said plugins, Composio or MCP servers, and "instructions" where it said
// soul. Only the words change; the keys, the screens and the other
// languages stay as they are. i18n's t() reads this map first.
import type { LocaleKey } from "@/locales";

export const V3_WORDS: Partial<Record<LocaleKey, string>> = {
  "connectors.title": "Apps",
  "connectors.subtitle": "Connect the apps your bots can use for you.",
  "connectors.closeAria": "Close apps",
  "connectors.typeAria": "App type",
  "connectors.tab.mcp": "Custom apps",
  "connectors.needsComposioKey": "Connected apps need an apps key. Add yours in Settings > Connections.",
  "connectors.addComposioKey": "Add your apps key",
  "connectors.updateKey": "Update your apps key",
  "connectors.selfHostOnlyReason": "Twitter/X needs your own X developer app. Use self-hosted connected apps for now.",
  "keys.composio.label": "Apps key",
  "keys.composio.desc": "Use your own Composio project key to connect Gmail, GitHub, Slack, Notion and other apps.",
  "mcp.removeConfirm": "Remove the “{name}” custom app?",
  "mcp.title": "Your custom apps",
  "mcp.subtitle": "Add a custom app once, a command on this computer or a server at a URL, and every bot that can use it gets its tools. Your bots still ask before they act, as usual.",
  "mcp.refreshAria": "Refresh custom apps",
  "mcp.editorNew": "Add custom app",
  "mcp.loading": "Loading custom apps…",
  "mcp.empty.title": "No custom apps yet",
  "mcp.empty.desc": "Add one you trust, a command on this computer or a URL, to give your bots more tools.",
  "mcp.claude.title": "Also use my Claude Code apps",
  "mcp.claude.aria": "Use my Claude Code apps",
  "botAccess.mcpRefreshError": "Could not refresh custom apps.",
  "botAccess.mcpEmpty": "No custom apps added yet.",
  "botAccess.mcpDisabled": "Switched off under Apps. Test it and turn it on there first.",
  "botAccess.mcpAdd": "Add a custom app…",
  "botAccess.mcpBusy": "Wait until this bot finishes all active tasks before changing its custom apps.",
};
