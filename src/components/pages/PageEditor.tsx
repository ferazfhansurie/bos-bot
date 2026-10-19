import { useCallback, useEffect, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { TaskList, TaskItem } from "@tiptap/extension-list";
import { Table, TableRow, TableHeader, TableCell } from "@tiptap/extension-table";
import Highlight from "@tiptap/extension-highlight";
import { Placeholder } from "@tiptap/extensions";
import Mathematics from "@tiptap/extension-mathematics";
import { FileText, ChevronDown, Sparkles, ImagePlus, Plus, History, MessageSquare, PanelLeft, MoreHorizontal, Share2, X, Check, Pin, Bold, Italic, Underline, Link, List, Table2 } from "lucide-react";
import { mergeBlocks, pageAskRequest, pageToMarkdown, type PageRecord, type PageSummary } from "../../../shared/page";
import { BlockIds, Callout, pageImage, PageMarks, pageMarksKey, slashCommands, type SlashItem, type SlashState } from "./extensions";
import { blocksToDoc, docToBlocks } from "./page-doc";
import { pageApi, PageApiError, PAGE_CHANGED_EVENT } from "./page-api";
import "katex/dist/katex.min.css";
import "./pages.css";

interface Props { botId: string; threadId: string; pageId?: string; onPage: (id: string, title: string) => void; onAsk: (text: string, threadId: string) => void; }
type Panel = "comments" | "history" | "activity" | null;
const time = (at: number) => new Date(at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export function PageEditor({ botId, threadId, pageId, onPage, onAsk }: Props) {
  const [page, setPage] = useState<PageRecord | null>(null);
  const [pages, setPages] = useState<PageSummary[]>([]);
  const [listOpen, setListOpen] = useState(!pageId);
  const [query, setQuery] = useState("");
  const [trash, setTrash] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [attribution, setAttribution] = useState(false);
  const [slash, setSlash] = useState<SlashState | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const [comment, setComment] = useState("");
  const [reply, setReply] = useState<Record<string, string>>({});
  const [ask, setAsk] = useState("");
  const [icon, setIcon] = useState("");
  const [activeComment, setActiveComment] = useState<string | null>(null);
  const [selection, setSelection] = useState({ blockId: "", quote: "" });
  const current = useRef<PageRecord | null>(null);
  const dirty = useRef(false);
  const pending = useRef<Promise<void>>(Promise.resolve());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const slashRef = useRef<SlashState | null>(null);
  const slashIndexRef = useRef(0);
  const callbacks = useRef({ onPage, onAsk }); callbacks.current = { onPage, onAsk };
  const file = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  const fail = (e: unknown) => { if (alive.current) setError(e instanceof Error ? e.message : String(e)); };
  const accept = useCallback((next: PageRecord) => { current.current = next; setPage(next); }, []);
  const itemsRef = useRef<SlashItem[]>([]);
  const editor = useEditor({
    extensions: [StarterKit.configure({ heading: { levels: [1, 2, 3] }, link: { openOnClick: false } }), TaskList, TaskItem.configure({ nested: true }),
      Table.configure({ resizable: true }), TableRow, TableHeader, TableCell, Highlight, Mathematics, BlockIds, Callout,
      pageImage(() => src => current.current ? pageApi.assetUrl(botId, current.current.id, src) : src), PageMarks,
      Placeholder.configure({ placeholder: 'Write something, or type "/" for commands…' }),
      slashCommands({ items: q => itemsRef.current.filter(i => `${i.label} ${i.keywords}`.toLowerCase().includes(q.toLowerCase())),
        onState: s => { slashRef.current = s; setSlash(s); slashIndexRef.current = 0; setSlashIndex(0); },
        onKey: e => {
          const s = slashRef.current; if (!s) return false;
          if (e.key === "Escape") { slashRef.current = null; setSlash(null); return true; }
          if (["ArrowDown", "ArrowUp"].includes(e.key)) { e.preventDefault(); const n = (slashIndexRef.current + (e.key === "ArrowDown" ? 1 : -1) + s.items.length) % Math.max(s.items.length, 1); slashIndexRef.current = n; setSlashIndex(n); return true; }
          if (e.key === "Enter" && s.items[slashIndexRef.current]) { e.preventDefault(); s.items[slashIndexRef.current]!.run(editor!, s.range); setSlash(null); return true; }
          return false;
        } }),
    ],
    content: { type: "doc", content: [{ type: "paragraph" }] },
    onUpdate: () => { dirty.current = true; setStatus("Unsaved changes"); if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => { void flush(); }, 600); },
    onSelectionUpdate: ({ editor: ed }) => {
      const { $from, from, to } = ed.state.selection;
      let blockId = "";
      for (let d = $from.depth; d > 0; d--) if ($from.node(d).attrs.blockId) { blockId = $from.node(d).attrs.blockId; break; }
      setSelection({ blockId, quote: ed.state.doc.textBetween(from, to, " ") });
    },
  });
  const flush = useCallback(async () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    const run = async () => {
      const base = current.current;
      if (!base || !editor || !dirty.current) return;
      const blocks = docToBlocks(editor.getJSON());
      dirty.current = false; setStatus("Saving…");
      try {
        let saved: PageRecord;
        try { saved = await pageApi.save(botId, base.id, { baseRevision: base.revision, blocks }); }
        catch (e) {
          if (!(e instanceof PageApiError) || e.status !== 409 || !e.page) throw e;
          const merged = mergeBlocks(base.blocks, blocks, e.page.blocks);
          saved = await pageApi.save(botId, base.id, { baseRevision: e.page.revision, blocks: merged });
        }
        // Text typed while the request was in flight is a delta against
        // the submitted blocks, not against the server response. Rebase it
        // before advancing the base revision or the next save loses remote edits.
        if (current.current?.id === saved.id) {
          const nextBlocks = dirty.current ? mergeBlocks(blocks, docToBlocks(editor.getJSON()), saved.blocks) : saved.blocks;
          if (JSON.stringify(docToBlocks(editor.getJSON())) !== JSON.stringify(nextBlocks)) editor.commands.setContent(blocksToDoc(nextBlocks), { emitUpdate: false });
          accept(saved); setStatus(dirty.current ? "Unsaved changes" : "Saved"); setError(""); }
      } catch (e) { dirty.current = true; setStatus("Not saved"); fail(e); }
    };
    pending.current = pending.current.then(run); await pending.current;
  }, [editor, botId, accept]);
  const refreshList = useCallback(async () => { try { setPages(await pageApi.list(botId, { trash, query })); } catch (e) { fail(e); } }, [botId, trash, query]);
  useEffect(() => { void refreshList(); }, [refreshList, listOpen]);
  useEffect(() => {
    alive.current = true; let cancelled = false;
    current.current = null; setPage(null); dirty.current = false; setError("");
    if (pageId) pageApi.get(botId, pageId, true).then(p => { if (cancelled) return; accept(p); editor?.commands.setContent(blocksToDoc(p.blocks), { emitUpdate: false }); setIcon(p.icon ?? ""); }).catch(fail);
    return () => { cancelled = true; };
  }, [botId, pageId, editor, accept]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); void flush(); alive.current = false; }, [flush]);
  useEffect(() => {
    const update = async () => {
      const p = current.current; if (!p) return;
      await flush(); if (dirty.current) return;
      try { const next = await pageApi.get(botId, p.id); if (current.current?.id !== next.id || dirty.current || next.revision < (current.current?.revision ?? 0)) return; accept(next); editor?.commands.setContent(blocksToDoc(next.blocks), { emitUpdate: false }); } catch (e) { fail(e); }
    };
    window.addEventListener(PAGE_CHANGED_EVENT, update); window.addEventListener("focus", update);
    const before = (e: BeforeUnloadEvent) => { if (dirty.current) { e.preventDefault(); } };
    window.addEventListener("beforeunload", before);
    return () => { window.removeEventListener(PAGE_CHANGED_EVENT, update); window.removeEventListener("focus", update); window.removeEventListener("beforeunload", before); };
  }, [accept, botId, editor, flush]);
  useEffect(() => {
    const shortcut = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "e") { e.preventDefault(); setListOpen(v => !v); } };
    window.addEventListener("keydown", shortcut); return () => window.removeEventListener("keydown", shortcut);
  }, []);
  useEffect(() => { if (editor && page) editor.view.dispatch(editor.state.tr.setMeta(pageMarksKey, { comments: page.comments, attribution: attribution ? page.attribution : null, activeComment })); }, [editor, page, attribution, activeComment]);

  const mutate = async (fn: (p: PageRecord) => Promise<PageRecord>, reset = false) => {
    await flush(); if (dirty.current || !current.current) return;
    // A restore replaces the document; keep typing disabled until it settles.
    if (reset) editor?.setEditable(false, false);
    try { const next = await fn(current.current); accept(next); callbacks.current.onPage(next.id, next.title); if (reset) editor?.commands.setContent(blocksToDoc(next.blocks), { emitUpdate: false }); setError(""); } catch (e) { fail(e); }
    finally { if (reset) editor?.setEditable(true, false); }
  };
  const meta = (patch: { title?: string; icon?: string | null; fullWidth?: boolean }) => mutate(p => pageApi.save(botId, p.id, { baseRevision: p.revision, ...patch }));
  const open = async (id: string, title: string) => { await flush(); if (dirty.current) return; callbacks.current.onPage(id, title); setListOpen(false); };
  const create = async () => { await flush(); if (dirty.current) return; try { const p = await pageApi.create(botId, { threadId }); callbacks.current.onPage(p.id, p.title); setListOpen(false); } catch (e) { fail(e); } };
  const sendAsk = async (instruction: string) => {
    await flush(); const p = current.current; if (!p || dirty.current || !instruction.trim()) return;
    callbacks.current.onAsk(pageAskRequest({ pageId: p.id, title: p.title, instruction, blockIds: selection.blockId ? [selection.blockId] : undefined, quote: selection.quote }), p.threadId ?? threadId); setAsk(""); setMenu(null);
  };
  const upload = async (image: File) => { await flush(); const p = current.current; if (!p) return; try { const src = await pageApi.uploadAsset(botId, p.id, image); editor?.chain().focus().setImage({ src, alt: image.name }).run(); } catch (e) { fail(e); } };
  const command = (label: string, run: (ed: NonNullable<typeof editor>) => void, keywords = ""): SlashItem => ({ id: label, label, description: "", section: "Basic", keywords, run: (ed, range) => { ed.chain().focus().deleteRange(range).run(); run(ed); setSlash(null); } });
  itemsRef.current = [
    command("Text", e => { e.chain().setParagraph().run(); }),
    ...([1, 2, 3] as const).map(level => command(`Heading ${level}`, e => { e.chain().toggleHeading({ level }).run(); })),
    command("Bulleted list", e => { e.chain().toggleBulletList().run(); }), command("Numbered list", e => { e.chain().toggleOrderedList().run(); }),
    command("To-do list", e => { e.chain().toggleTaskList().run(); }, "checkbox task"), command("Quote", e => { e.chain().toggleBlockquote().run(); }),
    command("Callout", e => { e.chain().setNode("callout").run(); }, "highlight"), command("Code", e => { e.chain().toggleCodeBlock().run(); }),
    command("Divider", e => { e.chain().setHorizontalRule().run(); }), command("Table", e => { e.chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(); }),
    command("Image", () => file.current?.click()), command("Equation", e => { e.commands.insertContent({ type: "blockMath", attrs: { latex: "E=mc^2" } }); }),
    command("Ask bot", () => setMenu("ai"), "generate rewrite"),
  ];
  const copy = async () => { await flush(); if (current.current && !dirty.current) { try { await navigator.clipboard.writeText(pageToMarkdown(current.current)); setStatus("Copied"); } catch (e) { fail(e); } } };
  const download = async (format: "md" | "html" | "docx") => { await flush(); if (!current.current || dirty.current) return; const a = document.createElement("a"); a.href = pageApi.exportUrl(botId, current.current.id, format); a.download = ""; a.click(); setMenu(null); };
  return <div className="bos-pages" data-testid="page-editor">
    <header className="page-toolbar">
      <button title="Show pages" aria-label="Show pages" onClick={() => setListOpen(!listOpen)}><PanelLeft size={17} /></button>
      <button className="page-type" onClick={() => setMenu(menu === "page" ? null : "page")}><FileText size={17} /><span>Page</span><ChevronDown size={13} /></button>
      <span className="page-toolbar-group"><button title="Ask bot" onClick={() => setMenu(menu === "ai" ? null : "ai")}><Sparkles size={17} /></button><button title="Add image" onClick={() => file.current?.click()}><ImagePlus size={17} /></button><button title="Insert block" onClick={() => setMenu(menu === "insert" ? null : "insert")}><Plus size={19} /></button></span>
      <span className="page-toolbar-space" />
      <button title="Version history" onClick={() => setPanel(panel === "history" ? null : "history")}><History size={18} /></button>
      <button title="Comments" onClick={() => setPanel(panel === "comments" ? null : "comments")}><MessageSquare size={18} /></button>
      <button title="Share" onClick={() => setMenu(menu === "share" ? null : "share")}><Share2 size={17} /><span>Share</span></button>
      <button title="Page menu" onClick={() => setMenu(menu === "page" ? null : "page")}><MoreHorizontal size={18} /></button>
    </header>
    {error && <div className="page-error" role="alert">{error} <button onClick={() => void flush()}>Retry save</button></div>}
    {menu && <><button className="page-dismiss" aria-label="Close menu" onClick={() => setMenu(null)} /><div className={`page-popover ${menu === "ai" ? "page-ai" : ""}`}>
      {menu === "page" && <>
        <button onClick={() => { setListOpen(true); setMenu(null); }}>Show pages <small>⇧⌘E</small></button>
        <button onClick={() => { void mutate(p => pageApi.patch(botId, p.id, { pinned: !p.pinned })); setMenu(null); }}><Pin size={15} />{page?.pinned ? "Unpin" : "Pin"}</button>
        <button onClick={() => { document.querySelector<HTMLInputElement>(".page-title")?.focus(); setMenu(null); }}>Rename</button>
        <button onClick={() => void copy()}>Copy as markdown</button>
        <button onClick={() => setMenu("download")}>Download <ChevronDown size={13} /></button>
        <button onClick={() => { setAttribution(!attribution); setMenu(null); }}>Show attribution {attribution && <Check size={14} />}</button>
        <button onClick={() => { setPanel("activity"); setMenu(null); }}>Page activity</button>
        <button onClick={() => { void meta({ fullWidth: !page?.fullWidth }); setMenu(null); }}>{page?.fullWidth ? "Default width" : "Full width"}</button>
        <button onClick={() => { void mutate(p => pageApi.patch(botId, p.id, { trashed: !p.trashedAt })); setMenu(null); }}>{page?.trashedAt ? "Restore from trash" : "Move to trash"}</button>
      </>}
      {menu === "download" && <>{(["md", "html", "docx"] as const).map(f => <button key={f} onClick={() => void download(f)}>{f === "md" ? "Markdown (.md)" : f === "html" ? "Web page (.html)" : "Word document (.docx)"}</button>)}</>}
      {menu === "share" && <><p>Private to you and this bot. Copy a document or download it to share.</p><button onClick={() => void copy()}>Copy document</button><button onClick={() => setMenu("download")}>Download</button></>}
      {menu === "insert" && itemsRef.current.map(i => <button key={i.id} onClick={() => { if (editor) i.run(editor, { from: editor.state.selection.from, to: editor.state.selection.to }); setMenu(null); }}>{i.label}</button>)}
      {menu === "ai" && <><strong>Ask your bot</strong><p>{selection.quote ? `Selected: ${selection.quote.slice(0, 100)}` : "Make a change to this page"}</p><textarea aria-label="Page instruction" value={ask} onChange={e => setAsk(e.target.value)} placeholder="What should change?" /><button disabled={!ask.trim() || !page} onClick={() => void sendAsk(ask)}>Send to bot</button>{["Fix spelling and grammar", "Make it shorter", "Add more detail", "Improve the writing"].map(s => <button key={s} onClick={() => void sendAsk(s)}>{s}</button>)}</>}
      {menu === "icon" && <><label>Page icon<input aria-label="Page icon" value={icon} maxLength={12} onChange={e => setIcon(e.target.value)} /></label><button onClick={() => { void meta({ icon: icon || null }); setMenu(null); }}>Save icon</button><button onClick={() => { setIcon(""); void meta({ icon: null }); setMenu(null); }}>Remove icon</button></>}
    </div></>}
    <div className="page-body">
      {listOpen && <aside className="page-list"><div className="page-side-heading"><strong>Pages</strong><button aria-label="New page" onClick={() => void create()}><Plus size={17} /></button></div><input aria-label="Search pages" placeholder="Search pages" value={query} onChange={e => setQuery(e.target.value)} /><button onClick={() => setTrash(!trash)}>{trash ? "Show pages" : "Trash"}</button>{pages.map(p => <button className={`page-list-row ${p.id === pageId ? "is-active" : ""}`} key={p.id} onClick={() => void open(p.id, p.title)}><FileText size={15} /><span>{p.icon} {p.title || "Untitled page"}</span>{p.pinned && <Pin size={12} />}</button>)}{!pages.length && <p>No pages here yet.</p>}</aside>}
      <main className={`page-document ${page?.fullWidth ? "is-wide" : ""}`}>
        {!page ? <div className="page-empty"><h1>{pageId ? "Loading page…" : "Your pages"}</h1>{!pageId && <button onClick={() => void create()}>Create document</button>}</div> : <>
          <div className="page-title-wrap"><button className={`page-icon ${page.icon ? "has-icon" : ""}`} onClick={() => setMenu("icon")} aria-label="Add page icon">{page.icon || <Plus size={16} />}</button><input key={`${page.id}:${page.title}`} className="page-title" aria-label="Page title" placeholder="Untitled page" defaultValue={page.title === "Untitled page" ? "" : page.title} onBlur={e => { if ((e.target.value || "Untitled page") !== page.title) void meta({ title: e.target.value || "Untitled page" }); }} onKeyDown={e => { if (e.key === "Enter") { e.currentTarget.blur(); editor?.commands.focus(); } }} /><span className="page-status" aria-live="polite">{status}</span></div>
          {page.trashedAt && <div className="page-error">This page is in the trash. <button onClick={() => void mutate(p => pageApi.patch(botId, p.id, { trashed: false }))}>Restore page</button></div>}
          {editor && <div className="page-format" onMouseDown={e => e.preventDefault()}>
            <button title="Bold" onClick={() => editor.chain().focus().toggleBold().run()}><Bold size={14} /></button><button title="Italic" onClick={() => editor.chain().focus().toggleItalic().run()}><Italic size={14} /></button><button title="Underline" onClick={() => editor.chain().focus().toggleUnderline().run()}><Underline size={14} /></button>
            <button title="Bulleted list" onClick={() => editor.chain().focus().toggleBulletList().run()}><List size={14} /></button><button title="Link" onClick={() => setMenu("link")}><Link size={14} /></button><button title="Add comment" onClick={() => setPanel("comments")}><MessageSquare size={14} /></button>
            {editor.isActive("table") && <><button title="Add row" onClick={() => editor.chain().focus().addRowAfter().run()}><Table2 size={14} /> + row</button><button onClick={() => editor.chain().focus().addColumnAfter().run()}>+ column</button><button onClick={() => editor.chain().focus().deleteRow().run()}>− row</button><button onClick={() => editor.chain().focus().deleteColumn().run()}>− column</button></>}
          </div>}
          {menu === "link" && <form className="page-link" onSubmit={e => { e.preventDefault(); const href = new FormData(e.currentTarget).get("href") as string; if (/^(https?:|mailto:)/i.test(href)) editor?.chain().focus().setLink({ href }).run(); setMenu(null); }}><input name="href" aria-label="Link URL" placeholder="https://" /><button type="submit">Add link</button><button type="button" onClick={() => { editor?.chain().focus().unsetLink().run(); setMenu(null); }}>Remove</button></form>}
          <EditorContent editor={editor} />
        </>}
      </main>
      {panel && page && <aside className="page-side"><div className="page-side-heading"><strong>{panel === "history" ? "Version history" : panel === "activity" ? "Page activity" : "Comments"}</strong><button aria-label="Close sidebar" onClick={() => setPanel(null)}><X size={17} /></button></div>
        {panel === "comments" && <><form onSubmit={e => { e.preventDefault(); if (!comment.trim() || !selection.blockId) return; void mutate(p => pageApi.comment(botId, p.id, { ...selection, text: comment })).then(() => setComment("")); }}><small>{selection.blockId ? selection.quote || "Comment on this block" : "Select a block to comment"}</small><textarea aria-label="Comment text" value={comment} onChange={e => setComment(e.target.value)} placeholder="Leave a comment…" /><button disabled={!comment.trim() || !selection.blockId}>Comment</button></form>{page.comments.map(c => <article key={c.id} className={c.resolved ? "is-resolved" : ""} onClick={() => setActiveComment(c.id)}><strong>{c.author.name}</strong><small>{time(c.at)}{c.resolved && " · resolved"}</small>{c.quote && <blockquote>{c.quote}</blockquote>}<p>{c.text}</p>{c.replies.map(r => <p key={r.id}><b>{r.author.name}</b> {r.text}</p>)}<button onClick={() => void mutate(p => pageApi.updateComment(botId, p.id, c.id, { resolved: !c.resolved }))}>{c.resolved ? "Reopen" : "Resolve"}</button><form onSubmit={e => { e.preventDefault(); if (!reply[c.id]?.trim()) return; void mutate(p => pageApi.updateComment(botId, p.id, c.id, { reply: reply[c.id] })).then(() => setReply(s => ({ ...s, [c.id]: "" }))); }}><input aria-label={`Reply to ${c.author.name}`} value={reply[c.id] ?? ""} onChange={e => setReply(s => ({ ...s, [c.id]: e.target.value }))} placeholder="Reply…" /><button>Reply</button></form></article>)}</>}
        {panel === "history" && <><p>Saved checkpoints and snapshots before bot edits.</p>{[...page.versions].reverse().map(v => <article key={v.id}><strong>{v.title}</strong><small>{v.author.name} · {time(v.at)}</small><details><summary>Preview</summary><pre>{pageToMarkdown(v)}</pre></details><button onClick={() => void mutate(p => pageApi.restore(botId, p.id, v.id), true)}>Restore this version</button></article>)}</>}
        {panel === "activity" && [...page.activity].reverse().map((a, i) => <article key={i}><b>{a.author.name}</b> {a.action}<small>{time(a.at)}</small>{a.detail && <p>{a.detail}</p>}</article>)}
      </aside>}
    </div>
    {slash && slash.rect && <div className="page-slash page-popover" style={{ position: "fixed", top: Math.min(slash.rect.bottom + 6, window.innerHeight - 330), left: Math.min(slash.rect.left, window.innerWidth - 260) }}>{slash.items.length ? slash.items.map((i, index) => <button key={i.id} className={index === slashIndex ? "is-active" : ""} onMouseDown={e => { e.preventDefault(); if (editor) i.run(editor, slash.range); setSlash(null); }}>{i.label}</button>) : <p>No matching blocks</p>}</div>}
    <input hidden ref={file} type="file" accept="image/png,image/jpeg,image/gif,image/webp" onChange={e => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ""; }} />
  </div>;
}
