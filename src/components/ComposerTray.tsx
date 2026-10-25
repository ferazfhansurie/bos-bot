import { t } from "@/lib/i18n";

/** A pinned task can keep a different folder from the bot's default. */
export function workingFolderLabel(folder: string, botId: string, threadId: string): string {
  const normalized = folder.replace(/\\/g, "/").replace(/\/+$/, "");
  if (normalized.endsWith(`/task-workspaces/${botId}/${threadId}`)) return t("composer.tray.privateWorkspace");
  // the bot's own folder is named by its id: say what it is, not the uuid
  if (normalized.endsWith(`/workspaces/${botId}`)) return t("composer.tray.botWorkspace");
  return normalized.split("/").pop() || folder;
}
