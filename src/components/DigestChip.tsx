import { ClipboardList, ChevronDown, FileDiff, Undo2 } from "lucide-react";
import { useState } from "react";
import { api } from "@/state/store";
import { ConfirmDialog } from "./ConfirmDialog";

import { t } from "@/lib/i18n";
import type { Message } from "@/state/store";

/** The work digest as one quiet chip under a reply: how many tool calls the
 * turn made and how many files it changed, with the full digest text as the
 * tooltip. Shown under the same setting as tool chips (Settings → Tool
 * calls), because it is the summary of exactly those. */
export function DigestChip({ message }: { message: Message }) {
  const [expanded, setExpanded] = useState(false);
  const [viewing, setViewing] = useState(false);
  const [patch, setPatch] = useState<{ patch: string; truncated: boolean } | null>(null);
  const [loadingPatch, setLoadingPatch] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [undone, setUndone] = useState(false);
  const [error, setError] = useState("");
  const digest = message.digest;
  if (!digest) return null;
  const tools = digest.toolCalls ?? `${digest.tools.reduce((n, tool) => n + tool.count, 0)}${digest.toolsDropped ? "+" : ""}`;
  const files = digest.files ? digest.files.changed.length + digest.files.added.length + digest.files.deleted.length + (digest.files.truncated ?? 0) : null;
  const label = files === null
    ? t("chat.digestChipNoFiles", { tools })
    : t("chat.digestChip", { tools, files });
  const paths = digest.files ? [...digest.files.changed, ...digest.files.added, ...digest.files.deleted] : [];
  const lines = digest.files?.lines;
  const checkpoint = digest.files?.checkpoint;
  const counts = (path?: string) => {
    const values = path ? lines?.[path] : lines && Object.values(lines).reduce(([a, d], [x, y]) => [a + x, d + y], [0, 0]);
    return values ? <span className="inline-flex shrink-0 gap-1 text-[13px] leading-none tabular-nums tracking-tight"><span className="chat-git-added">+{values[0]}</span><span className="chat-git-deleted">−{values[1]}</span></span> : null;
  };
  const viewChanges = async () => {
    setViewing(!viewing);
    if (viewing || patch || !checkpoint) return;
    setLoadingPatch(true); setError("");
    try { setPatch(await api(`/api/bots/${encodeURIComponent(digest.botId)}/threads/${encodeURIComponent(digest.threadId)}/messages/${encodeURIComponent(message.id)}/diff`)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Checkpoint diff unavailable"); }
    finally { setLoadingPatch(false); }
  };
  const restore = async () => {
    if (!checkpoint || busy) return;
    setBusy(true); setError(""); setConfirming(false);
    try {
      await api(`/api/bots/${encodeURIComponent(digest.botId)}/checkpoints/restore`, { method: "POST", body: JSON.stringify({ cwd: checkpoint.cwd, hash: undone ? checkpoint.after : checkpoint.before }) });
      setUndone(!undone);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Failed to restore changes"); }
    finally { setBusy(false); }
  };
  if (paths.length) return (
    <div data-testid="digest-chip" title={message.text ?? t("chat.digestTitle")} className="chat-stroke mb-2 overflow-hidden rounded-[12.5px] bg-[var(--chat-elevated)] text-[14px]">
      <div className="flex min-w-0 flex-wrap items-center gap-2.5 px-3 py-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-[12.5px] bg-[var(--chat-soft)] chat-text-secondary"><FileDiff size={24} /></span>
        <div className="min-w-0 flex-1"><div className="truncate font-medium">Edited {files === 1 ? paths[0]?.split("/").pop() : `${files} files`}</div>{counts()}</div>
        {checkpoint && <button className="chat-ghost flex h-7 items-center gap-1 px-2" disabled={busy} onClick={() => setConfirming(true)}><Undo2 size={14} />{busy ? "Restoring…" : undone ? "Reapply" : "Undo"}</button>}
        <button aria-expanded={viewing} onClick={() => void viewChanges()} className="h-7 rounded-[12.5px] border chat-hairline px-2 hover:bg-[var(--chat-ghost-hover)]">View changes</button>
      </div>
      {(paths.length > 1 || viewing) && <div className="border-t chat-hairline">
        {(expanded ? paths : paths.slice(0, 3)).map(path => {
          const slash = path.lastIndexOf("/");
          return <div key={path} className="flex h-9 min-w-0 items-center gap-2 px-3 hover:bg-[var(--chat-ghost-hover)]"><span className="min-w-0 flex-1 truncate"><span className="chat-text-tertiary">{path.slice(0, slash + 1)}</span>{path.slice(slash + 1)}</span>{counts(path)}</div>;
        })}
        {paths.length > 3 && <button onClick={() => setExpanded(!expanded)} className="chat-text-tertiary flex h-9 w-full items-center justify-center gap-1 hover:bg-[var(--chat-ghost-hover)]">{expanded ? "Collapse files" : `Show ${paths.length - 3} more files`}<ChevronDown size={14} className={expanded ? "rotate-180" : undefined} /></button>}
      </div>}
      {viewing && <div className="border-t chat-hairline text-xs">
        {loadingPatch ? <p role="status" className="px-3 py-2 chat-text-secondary">Loading changes…</p> : patch ? <>
          <pre dir="ltr" aria-label="Checkpoint diff" className="max-h-96 overflow-auto p-3 font-mono leading-5">{patch.patch.split("\n").map((line, index) => <div key={index} className={line.startsWith("+") ? "chat-git-added" : line.startsWith("-") ? "chat-git-deleted" : "chat-text-secondary"}>{line || " "}</div>)}</pre>
          {patch.truncated && <p className="px-3 py-2 chat-text-secondary">Too large to render in full. Showing the first 200,000 characters.</p>}
        </> : !checkpoint && <p className="px-3 py-2 chat-text-secondary">Recorded file summary. Checkpoint diff and restore are unavailable for this turn.</p>}
        {Boolean(digest.files?.truncated) && <p className="px-3 py-2 chat-text-secondary">{digest.files?.truncated} additional paths were omitted from the receipt.</p>}
      </div>}
      {error && <p role="alert" className="px-3 py-2 text-xs text-danger">{error}</p>}
      {undone && <p role="status" className="px-3 py-2 text-xs chat-text-secondary">Changes reverted</p>}
      {confirming && <ConfirmDialog open tone="neutral" title={undone ? "Reapply changes?" : "Undo changes?"} body={`Restore all checkpointed files in ${checkpoint!.cwd}. Later edits in this folder will be replaced.`} confirmLabel={undone ? "Reapply" : "Undo"} onConfirm={() => void restore()} onCancel={() => setConfirming(false)} />}
    </div>
  );
  return (
    <div className="flex justify-start" data-testid="digest-chip">
      <span
        title={message.text ?? t("chat.digestTitle")}
        className="inline-flex max-w-[480px] items-center gap-1.5 rounded-full border border-hairline/40 bg-panel px-3 py-1 text-[12px] text-ink-secondary"
      >
        <ClipboardList size={12} />
        <span className="truncate">{label}</span>
      </span>
    </div>
  );
}

/** Context changes are visible even when ordinary tool chips are hidden. */
export function CompactionChip({ message }: { message: Message }) {
  if (!message.compaction) return null;
  return (
    <details className="max-w-[600px] rounded-xl border border-hairline/40 bg-panel px-3 py-2 text-[12px] text-ink-secondary" data-testid="compaction-chip">
      <summary className="cursor-pointer font-medium">{t("chat.compactionTitle")}</summary>
      <p className="mt-2">{t("chat.compactionHint")}</p>
      <p className="mt-2 whitespace-pre-wrap break-words">{message.compaction.summary}</p>
    </details>
  );
}
