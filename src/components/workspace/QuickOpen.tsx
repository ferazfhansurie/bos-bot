import { useEffect, useId, useRef, useState } from "react";
import { File, Loader2, Search } from "lucide-react";

import { cn } from "@/lib/cn";
import type { TerminalTarget } from "@/lib/terminal";
import { searchFiles } from "@/lib/workspace-files-client";

/** ⌘P: fuzzy-find a file in the thread's working folder. */
export function QuickOpen({ target, onOpen, onClose }: { target: TerminalTarget; onOpen: (path: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [cursor, setCursor] = useState(0);
  const listId = useId();
  const { botId, threadId } = target;
  const selectedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    const timer = setTimeout(() => {
      searchFiles({ botId, threadId }, query.trim(), controller.signal)
        .then((result) => { setFiles(result.files); setCursor(0); setError(""); })
        .catch((cause: unknown) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "search failed"); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, query ? 90 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [botId, threadId, query]);

  useEffect(() => selectedRef.current?.scrollIntoView({ block: "nearest" }), [cursor]);

  const selected = files.length ? Math.min(cursor, files.length - 1) : 0;
  const open = (path: string | undefined) => { if (!path) return; onOpen(path); onClose(); };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
    else if (event.key === "ArrowDown" || (event.ctrlKey && event.key === "n")) { event.preventDefault(); setCursor(files.length ? (selected + 1) % files.length : 0); }
    else if (event.key === "ArrowUp" || (event.ctrlKey && event.key === "p")) { event.preventDefault(); setCursor(files.length ? (selected - 1 + files.length) % files.length : 0); }
    else if (event.key === "Enter") { event.preventDefault(); open(files[selected]); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-6 pt-[14vh] backdrop-blur-[2px]"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()} onKeyDown={onKeyDown}>
      <div role="dialog" aria-modal="true" aria-label="go to file"
        className="flex max-h-[min(520px,72vh)] w-full max-w-[600px] flex-col overflow-hidden rounded-xl border border-hairline/50 bg-card shadow-2xl shadow-black/60 motion-safe:animate-pop-in">
        <div className="flex items-center gap-3 border-b border-hairline/40 px-4 py-3">
          <Search size={16} className="shrink-0 text-ink-secondary" />
          <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`go to a file in ${target.name || "this folder"}…`}
            role="combobox" aria-expanded="true" aria-controls={listId} aria-autocomplete="list"
            className="w-full bg-transparent text-[14px] text-ink placeholder:text-ink-secondary focus:outline-none" />
          {loading && <Loader2 size={14} className="shrink-0 text-ink-secondary motion-safe:animate-spin" />}
        </div>
        <div id={listId} role="listbox" aria-label="files" className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {error ? <div role="alert" className="px-3 py-6 text-center text-[13px] text-danger">{error}</div>
            : !files.length && !loading ? <div className="px-3 py-8 text-center text-[13px] text-ink-secondary">{query.trim() ? `nothing matches “${query.trim()}”` : "no files here"}</div>
            : files.map((path, index) => {
              const cut = path.lastIndexOf("/");
              return (
                <div key={path} role="option" aria-selected={index === selected} ref={index === selected ? selectedRef : undefined}
                  onClick={() => open(path)} onMouseMove={() => setCursor(index)}
                  className={cn("flex cursor-default select-none items-center gap-2.5 rounded-lg px-2.5 py-1.5", index === selected ? "bg-raised" : "hover:bg-raised/50")}>
                  <File size={13} className="shrink-0 text-ink-secondary" />
                  <span className="shrink-0 text-[13.5px] text-ink">{path.slice(cut + 1)}</span>
                  {cut > 0 && <span className="min-w-0 truncate text-[12.5px] text-ink-secondary">{path.slice(0, cut)}</span>}
                </div>
              );
            })}
        </div>
      </div>
    </div>
  );
}
