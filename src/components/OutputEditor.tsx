import { useRef, useState } from "react";
import { api, useStore, type Bot, type Message } from "@/state/store";
import { OUTPUT_MAX_LENGTH, outputRevisionRequest, type OutputDraft } from "../../shared/output-draft";

const button = "rounded-lg border border-hairline px-2.5 py-1 text-xs hover:bg-raised disabled:opacity-40";

/** An explicit working copy: historical assistant text is never rewritten. */
export function OutputEditor({ bot, message, onClose }: { bot: Bot; message: Message; onClose: () => void }) {
  const { dispatch } = useStore();
  const [saved, setSaved] = useState<OutputDraft>(() => message.outputDraft ?? { revision: 0, versions: [message.text ?? ""], comments: [] });
  const [version, setVersion] = useState(saved.versions.length - 1);
  const [history, setHistory] = useState([saved.versions[version]]);
  const [cursor, setCursor] = useState(0);
  const [comment, setComment] = useState("");
  const [selection, setSelection] = useState<{ start: number; end: number; quote: string }>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [requested, setRequested] = useState(false);
  const editor = useRef<HTMLTextAreaElement>(null);
  const text = history[cursor];
  const dirty = text !== saved.versions[version];
  const persist = async (next: OutputDraft): Promise<OutputDraft | undefined> => {
    setPending(true); setError("");
    try {
      const result = await api<{ message: Message }>(`/api/threads/${encodeURIComponent(bot.threadId)}/messages/${encodeURIComponent(message.id)}/output-draft`, { method: "POST", body: JSON.stringify(next) });
      if (!result.message.outputDraft) throw new Error("draft was not saved");
      setSaved(result.message.outputDraft); setRequested(false);
      return result.message.outputDraft;
    } catch (e) { setError(e instanceof Error ? e.message : "could not save draft"); return undefined; }
    finally { setPending(false); }
  };
  const selectVersion = (index: number) => {
    setVersion(index); setHistory([saved.versions[index]]); setCursor(0); setSelection(undefined);
  };
  const save = async () => {
    const next = await persist({ ...saved, versions: [...saved.versions, text] });
    if (next) { setVersion(next.versions.length - 1); setHistory([text]); setCursor(0); setSelection(undefined); }
  };
  return <section aria-label="output working copy" className="mt-3 w-full min-w-0 rounded-xl border border-hairline bg-card p-3">
    <div className="flex flex-wrap items-center gap-2">
      <strong className="text-sm">working copy</strong>
      <span className="text-xs text-ink-secondary">original reply preserved · saved with this message</span>
      <button type="button" className={`${button} ml-auto`} disabled={pending || dirty} onClick={onClose}>close</button>
    </div>
    <div className="my-2 flex flex-wrap items-center gap-2">
      <select aria-label="output version" className="rounded-lg bg-inset p-1 text-xs" value={version} disabled={pending || dirty} onChange={e => selectVersion(Number(e.target.value))}>
        {saved.versions.map((_, i) => <option key={i} value={i}>{i === 0 ? "original" : `version ${i + 1}`}</option>)}
      </select>
      <button type="button" className={button} disabled={pending || cursor === 0} onClick={() => { setCursor(cursor - 1); setSelection(undefined); }}>undo</button>
      <button type="button" className={button} disabled={pending || cursor === history.length - 1} onClick={() => { setCursor(cursor + 1); setSelection(undefined); }}>redo</button>
      <button type="button" className={button} disabled={pending || !dirty || saved.versions.length >= 30} onClick={() => void save()}>save version</button>
      {dirty && <button type="button" className={button} disabled={pending} onClick={() => selectVersion(version)}>discard changes</button>}
      <span role="status" className="text-xs text-ink-secondary">{pending ? "saving…" : dirty ? "unsaved changes" : saved.revision ? "saved" : "original"}</span>
    </div>
    <textarea ref={editor} aria-label="edit output" value={text} disabled={pending} maxLength={OUTPUT_MAX_LENGTH} rows={Math.min(22, Math.max(6, text.split("\n").length))}
      className="w-full resize-y rounded-lg border border-hairline bg-inset p-3 text-sm leading-relaxed focus:outline-accent"
      onSelect={() => {
        const el = editor.current;
        if (el && el.selectionEnd > el.selectionStart) setSelection({ start: el.selectionStart, end: el.selectionEnd, quote: el.value.slice(el.selectionStart, el.selectionEnd) });
      }}
      onChange={e => { const next = [...history.slice(0, cursor + 1), e.target.value].slice(-100); setHistory(next); setCursor(next.length - 1); setSelection(undefined); setRequested(false); }} />
    <p className="my-2 text-xs text-ink-secondary">select text in a saved version to attach a comment. save edits before commenting.</p>
    {selection && !dirty && <blockquote className="max-h-24 overflow-auto border-l-2 border-accent pl-2 text-xs whitespace-pre-wrap">{selection.quote}</blockquote>}
    <div className="mt-2 flex items-start gap-2">
      <textarea aria-label="output comment" placeholder="what should change?" disabled={pending} value={comment} onChange={e => setComment(e.target.value)} maxLength={4000} rows={2} className="min-w-0 flex-1 rounded-lg border border-hairline bg-inset p-2 text-sm" />
      <button type="button" className={button} disabled={pending || dirty || !selection || !comment.trim() || saved.comments.length >= 100} onClick={async () => {
        if (!selection) return;
        const next = await persist({ ...saved, comments: [...saved.comments, { id: crypto.randomUUID(), version, ...selection, text: comment.trim() }] });
        if (next) { setComment(""); setSelection(undefined); }
      }}>add comment</button>
    </div>
    <ol className="my-2 space-y-2">
      {saved.comments.map(c => <li key={c.id} className="rounded-lg border border-hairline p-2 text-xs">
        <div className="flex gap-2"><button type="button" className="text-accent" disabled={dirty || pending} onClick={() => selectVersion(c.version)}>{c.version === 0 ? "original" : `version ${c.version + 1}`} · {c.start + 1}–{c.end}</button>
          <button type="button" className="ml-auto text-ink-secondary" disabled={pending} aria-label={`remove comment: ${c.text}`} onClick={() => void persist({ ...saved, comments: saved.comments.filter(item => item.id !== c.id) })}>remove</button></div>
        <blockquote className="my-1 max-h-20 overflow-auto whitespace-pre-wrap text-ink-secondary">{c.quote}</blockquote><p className="whitespace-pre-wrap">{c.text}</p>
      </li>)}
    </ol>
    {saved.versions.length >= 30 && <p className="text-xs text-ink-secondary">30 saved versions reached. request a revision to continue in a new reply.</p>}
    {error && <p role="alert" className="my-2 text-xs text-danger">{error}</p>}
    <button type="button" className={button} disabled={pending || dirty || bot.busy || !saved.comments.length || !!comment.trim() || requested} onClick={() => {
      dispatch({ type: "send", botId: bot.id, threadId: bot.threadId, text: outputRevisionRequest(message.id, saved, version) }); setRequested(true);
    }}>{requested ? "revision requested" : "request revision in this thread"}</button>
  </section>;
}
