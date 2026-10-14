import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, LoaderCircle, RefreshCw, Undo2 } from "lucide-react";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { cn } from "@/lib/cn";
import type { TerminalTarget } from "@/lib/terminal";
import { fetchChanges, revertPath, type WorkspaceChangeStatus, type WorkspaceChanges } from "@/lib/workspace-files-client";

const POLL_MS = 5000;
/** A file with more diff lines than this starts folded. */
const FOLD_LINES = 400;

interface FilePatch { path: string; lines: string[]; binary: boolean }

/** Split a unified diff into one entry per file. */
export function splitPatch(patch: string): FilePatch[] {
  const files: FilePatch[] = [];
  for (const chunk of patch.split(/^(?=diff --git )/m)) {
    if (!chunk.startsWith("diff --git ")) continue;
    const lines = chunk.replace(/\n$/, "").split("\n");
    const plus = lines.find((line) => line.startsWith("+++ "));
    const minus = lines.find((line) => line.startsWith("--- "));
    let path = plus && plus !== "+++ /dev/null" ? plus.slice(6) : minus && minus !== "--- /dev/null" ? minus.slice(6) : "";
    if (!path) {
      const rest = lines[0]!.slice("diff --git ".length);
      const length = (rest.length - 5) / 2;
      path = Number.isInteger(length) ? rest.slice(2, 2 + length) : rest;
    }
    const start = lines.findIndex((line) => line.startsWith("@@"));
    files.push({ path, lines: start < 0 ? [] : lines.slice(start), binary: lines.some((line) => line.startsWith("Binary files ")) });
  }
  return files;
}

const STATUS: Record<WorkspaceChangeStatus, { letter: string; tone: string }> = {
  modified: { letter: "M", tone: "text-warning" },
  added: { letter: "A", tone: "text-success" },
  untracked: { letter: "U", tone: "text-success" },
  deleted: { letter: "D", tone: "text-danger" },
  changed: { letter: "C", tone: "text-ink-secondary" },
};

export function ChangesTab({ target, active, onChanges, onOpenFile }: {
  target: TerminalTarget; active: boolean; onChanges?: (changes: WorkspaceChanges) => void; onOpenFile?: (path: string) => void;
}) {
  const where = useMemo(() => ({ botId: target.botId, threadId: target.threadId }), [target.botId, target.threadId]);
  const [changes, setChanges] = useState<WorkspaceChanges | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [folded, setFolded] = useState<Record<string, boolean>>({});
  const [confirm, setConfirm] = useState<{ path: string; status: WorkspaceChangeStatus } | null>(null);
  const [reverting, setReverting] = useState("");
  const report = useRef(onChanges);
  report.current = onChanges;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = await fetchChanges(where);
      setChanges((previous) => (previous && previous.patch === next.patch && previous.files?.length === next.files?.length ? previous : next));
      report.current?.(next);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "changes unavailable");
    } finally {
      setLoading(false);
    }
  }, [where]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => { if (document.visibilityState === "visible") void load(); }, POLL_MS);
    return () => clearInterval(timer);
  }, [active, load]);

  const patches = useMemo(() => new Map(splitPatch(changes?.patch ?? "").map((file) => [file.path, file])), [changes?.patch]);

  const revert = async () => {
    if (!confirm) return;
    const { path } = confirm;
    setConfirm(null);
    setReverting(path);
    try { await revertPath(where, path); setError(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "revert failed"); }
    finally { setReverting(""); void load(); }
  };

  const files = changes?.files ?? [];
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-app" data-testid="workspace-changes">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-hairline/50 px-3 text-[12px] text-ink-secondary">
        <span className="min-w-0 flex-1 truncate">
          {changes?.git === false ? "not a git repository" : changes ? (files.length ? `${files.length} changed file${files.length === 1 ? "" : "s"}` : "no uncommitted changes") : "reading changes…"}
        </span>
        <button type="button" title="refresh" aria-label="refresh" onClick={() => void load()} className="rounded p-1 hover:bg-raised hover:text-ink">
          {loading ? <LoaderCircle size={12} className="animate-spin" /> : <RefreshCw size={12} />}
        </button>
      </div>
      {error && <p role="alert" className="px-3 py-2 text-[12px] text-danger">{error}</p>}
      <div className="min-h-0 flex-1 overflow-auto">
        {files.map((file) => {
          const patch = patches.get(file.path);
          const count = patch?.lines.length ?? 0;
          const isFolded = folded[file.path] ?? count > FOLD_LINES;
          const status = STATUS[file.status];
          return (
            <section key={file.path} className="border-b border-hairline/40">
              <div className="group sticky top-0 z-10 flex h-8 items-center gap-1.5 bg-app px-2 text-[12.5px]">
                <button type="button" onClick={() => setFolded((all) => ({ ...all, [file.path]: !isFolded }))} aria-label={isFolded ? "show diff" : "hide diff"}
                  className="rounded p-0.5 text-ink-secondary hover:bg-raised hover:text-ink">{isFolded ? <ChevronRight size={13} /> : <ChevronDown size={13} />}</button>
                <span className={cn("w-3 shrink-0 text-center font-mono text-[11px]", status.tone)} title={file.status}>{status.letter}</span>
                <button type="button" onClick={() => file.status !== "deleted" && onOpenFile?.(file.path)} title={file.path}
                  className="min-w-0 flex-1 truncate text-left text-ink hover:underline">{file.path}</button>
                <button type="button" disabled={reverting === file.path} onClick={() => setConfirm({ path: file.path, status: file.status })}
                  title="revert this file" aria-label={`revert ${file.path}`}
                  className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11.5px] text-ink-secondary opacity-0 hover:bg-raised hover:text-ink focus:opacity-100 group-hover:opacity-100 disabled:opacity-100">
                  {reverting === file.path ? <LoaderCircle size={11} className="animate-spin" /> : <Undo2 size={11} />}revert
                </button>
              </div>
              {!isFolded && (patch?.binary ? <p className="px-8 pb-2 text-[12px] text-ink-secondary">binary file</p>
                : patch && count ? <DiffLines lines={patch.lines} />
                : <p className="px-8 pb-2 text-[12px] text-ink-secondary">{file.status === "deleted" ? "deleted" : "no text changes to show"}</p>)}
            </section>
          );
        })}
        {changes?.truncated && <p className="px-3 py-2 text-[11.5px] text-ink-secondary">the diff is too large to show in full</p>}
      </div>
      <ConfirmDialog
        open={Boolean(confirm)}
        tone="danger"
        title="revert this file?"
        body={confirm ? (confirm.status === "untracked" || confirm.status === "added"
          ? `${confirm.path} is new. reverting deletes it from disk. this can't be undone.`
          : `${confirm.path} goes back to the last commit. its uncommitted changes are lost.`) : ""}
        confirmLabel="revert"
        onCancel={() => setConfirm(null)}
        onConfirm={() => void revert()}
      />
    </div>
  );
}

function DiffLines({ lines }: { lines: string[] }) {
  const rows: { kind: "hunk" | "add" | "del" | "ctx" | "meta"; text: string; old?: number; next?: number }[] = [];
  let old = 0, next = 0;
  for (const line of lines) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) { old = Number(hunk[1]); next = Number(hunk[2]); rows.push({ kind: "hunk", text: line }); continue; }
    if (line.startsWith("\\")) { rows.push({ kind: "meta", text: line.slice(2) }); continue; }
    if (line.startsWith("+")) rows.push({ kind: "add", text: line.slice(1), next: next++ });
    else if (line.startsWith("-")) rows.push({ kind: "del", text: line.slice(1), old: old++ });
    else rows.push({ kind: "ctx", text: line.slice(1), old: old++, next: next++ });
  }
  return (
    <div className="overflow-x-auto pb-1 font-mono text-[12px] leading-[1.5]">
      <table className="min-w-full border-collapse">
        <tbody>
          {rows.map((row, index) => (
            <tr key={index} className={cn(row.kind === "add" && "bg-success/10", row.kind === "del" && "bg-danger/10", row.kind === "hunk" && "bg-inset")}>
              <td className="w-10 select-none px-1 text-right align-top text-ink-secondary/60">{row.old ?? ""}</td>
              <td className="w-10 select-none px-1 text-right align-top text-ink-secondary/60">{row.next ?? ""}</td>
              <td className={cn("w-4 select-none text-center align-top", row.kind === "add" ? "text-success" : row.kind === "del" ? "text-danger" : "text-ink-secondary/60")}>
                {row.kind === "add" ? "+" : row.kind === "del" ? "-" : ""}
              </td>
              <td className={cn("whitespace-pre pr-3", row.kind === "hunk" || row.kind === "meta" ? "text-ink-secondary" : "text-ink")}>{row.text}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
