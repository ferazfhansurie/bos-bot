import { Code2, ExternalLink, FolderOpen, MousePointer2 } from "lucide-react";

import type { RowMenuItem } from "@/components/RowContextMenu";

export type OpenInTarget = "cursor" | "vscode" | "reveal" | "default";

export function openInAvailable(): boolean {
  return typeof window !== "undefined" && typeof window.ogb?.workspaceOpenIn === "function";
}

export function openIn(path: string, target: OpenInTarget): void {
  void window.ogb?.workspaceOpenIn?.(path, target).catch(() => false);
}

const revealLabel = () => (window.ogb?.platform === "darwin" ? "reveal in finder" : window.ogb?.platform === "win32" ? "show in explorer" : "show in folder");

/** "open in cursor / vscode / reveal" rows for a context menu. */
export function openInItems(path: string, folder = false): RowMenuItem[] {
  if (!openInAvailable()) return [];
  return [
    { key: "cursor", label: "open in cursor", icon: <MousePointer2 size={15} />, onSelect: () => openIn(path, "cursor") },
    { key: "vscode", label: "open in vscode", icon: <Code2 size={15} />, onSelect: () => openIn(path, "vscode") },
    { key: "reveal", label: revealLabel(), icon: <FolderOpen size={15} />, onSelect: () => openIn(path, "reveal") },
    ...(folder ? [] : [{ key: "default", label: "open with default app", icon: <ExternalLink size={15} />, onSelect: () => openIn(path, "default") }]),
  ];
}
