/** Client for /api/workspace-files: a thread's working folder, read through
 * the local server. Only the desktop owner can reach it (Electron adds the
 * owner header to loopback requests from every BOS window). */
import type { TerminalTarget } from "@/lib/terminal";

export interface WorkspaceEntry { name: string; path: string; kind: "dir" | "file"; size?: number; mtime?: number }
export interface WorkspaceListing { root: string; path: string; entries: WorkspaceEntry[]; truncated: boolean }
export interface WorkspaceFile { path: string; size: number; mtime: number; binary: boolean; truncated: boolean; content: string }
export interface WorkspaceStat { path: string; kind: "dir" | "file"; size: number; mtime: number }
export interface WorkspaceLocation { root: string; path: string; kind: "dir" | "file" }
export type WorkspaceChangeStatus = "modified" | "added" | "deleted" | "untracked" | "changed";
export interface WorkspaceChanges { git: boolean; files?: { path: string; status: WorkspaceChangeStatus }[]; patch?: string; truncated?: boolean }

type Where = Pick<TerminalTarget, "botId" | "threadId">;

export class WorkspaceFilesError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

export function workspaceFilesUrl(target: Where, action: string, params: Record<string, string> = {}): string {
  return `/api/workspace-files/${action}?${new URLSearchParams({ botId: target.botId, threadId: target.threadId, ...params })}`;
}

async function getJson<T>(target: Where, action: string, params: Record<string, string>, signal?: AbortSignal): Promise<T> {
  const res = await fetch(workspaceFilesUrl(target, action, params), { signal, cache: "no-store" });
  const data = await res.json().catch(() => ({})) as { error?: string };
  if (!res.ok) throw new WorkspaceFilesError((data.error ?? "workspace files unavailable").toLowerCase(), res.status);
  return data as T;
}

export const listFolder = (target: Where, path: string, signal?: AbortSignal) => getJson<WorkspaceListing>(target, "list", { path }, signal);
export const readFile = (target: Where, path: string, signal?: AbortSignal) => getJson<WorkspaceFile>(target, "read", { path }, signal);
export const statPath = (target: Where, path: string, signal?: AbortSignal) => getJson<WorkspaceStat>(target, "stat", { path }, signal);
export const locatePath = (target: Where, path: string, signal?: AbortSignal) => getJson<WorkspaceLocation>(target, "locate", { path }, signal);
export const searchFiles = (target: Where, q: string, signal?: AbortSignal) =>
  getJson<{ root: string; files: string[]; truncated: boolean }>(target, "search", { q, limit: "60" }, signal);
export const fetchChanges = (target: Where, signal?: AbortSignal) => getJson<WorkspaceChanges>(target, "changes", {}, signal);

export async function fetchRaw(target: Where, path: string, signal?: AbortSignal): Promise<Blob> {
  const res = await fetch(workspaceFilesUrl(target, "raw", { path }), { signal, cache: "no-store" });
  if (!res.ok) {
    const data = await res.json().catch(() => ({})) as { error?: string };
    throw new WorkspaceFilesError((data.error ?? "preview unavailable").toLowerCase(), res.status);
  }
  return res.blob();
}

export async function revertPath(target: Where, path: string): Promise<void> {
  const res = await fetch("/api/workspace-files/revert", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ botId: target.botId, threadId: target.threadId, path }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({})) as { error?: string };
    throw new WorkspaceFilesError((data.error ?? "revert failed").toLowerCase(), res.status);
  }
}

/** Join the folder root and a relative path for the native "open in" calls. */
export function absolutePath(root: string, rel: string): string {
  if (!rel) return root;
  const windows = /^[a-z]:\\/i.test(root) || root.includes("\\");
  const separator = windows ? "\\" : "/";
  return `${root.replace(/[\\/]+$/, "")}${separator}${windows ? rel.split("/").join("\\") : rel}`;
}

export const RAW_PREVIEW = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg|pdf|mp4|m4v|webm|mov|mp3|m4a|aac|wav|flac|ogg|opus)$/i;
