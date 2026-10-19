/** Conversation header controls. Every item uses a BOS action; unsupported
 * fork/share/window actions are deliberately absent. Creation only appears
 * when a real page renderer is registered, never for a placeholder kind. */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Archive, ChevronRight, FileText, Globe, Layers, MoreHorizontal, Plus, X } from "lucide-react";
import { type Bot, type Message, openThread, useStore } from "@/state/store";
import { ConversationTools } from "@/components/ConversationChrome";
import { ChatMarkdown, localFilePath } from "@/components/ChatMarkdown";
import { RoutineEditor } from "@/components/RoutinesPage";
import { useWorkspace } from "@/components/workspace/WorkspaceContext";
import { Menu, anchorOf, type MenuAnchor, type MenuEntry } from "./Menu";
import { tabKind, useTabKinds } from "./registry";
import { rightVisible } from "@/lib/thread-workspace";
import { runWorkspaceCommand } from "@/lib/workspace-commands";
import { copyTranscriptToClipboard, formatTranscriptMarkdown } from "@/lib/export-transcript";
import { splitTranscriptAttachments } from "@/lib/composer-attachments";
import { threadRefUrl } from "@/lib/thread-refs";

const ICON = "flex size-7 shrink-0 items-center justify-center rounded-[10px] text-ink/70 transition-colors hover:bg-ink/[.078] hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent";
const PIN_EVENT = "bos-thread-pins-changed";

export function conversationResources(messages: readonly Message[]) {
  const outputs = new Map<string, { path: string; name: string; message: Message }>();
  const sources = new Map<string, { url: string; name: string }>();
  for (const message of messages) {
    if (message.role !== "bot" || message.kind !== "text") continue;
    const text = message.text ?? "";
    const attachments = splitTranscriptAttachments(text);
    for (const file of [...attachments.files, ...attachments.images, ...(message.attachments ?? []).map(file => ({ ...file, name: file.path.split(/[\\/]/).pop() ?? "File" }))]) {
      outputs.set(file.path, { path: file.path, name: file.name, message });
    }
    for (const match of text.matchAll(/\[([^\]\n]+)\]\(<?([^\s)]+)>?\)/g)) {
      const path = localFilePath(match[2]);
      if (path) outputs.set(path, { path, name: match[1], message });
      else {
        try { const url = new URL(match[2]); if (/^https?:$/.test(url.protocol)) sources.set(url.href, { url: url.href, name: match[1] }); } catch { /* not a web citation */ }
      }
    }
  }
  return { outputs: [...outputs.values()], sources: [...sources.values()] };
}

export function ConversationActions({ bot, messages, local, children }: { bot: Bot; messages: readonly Message[]; local: boolean; children: ReactNode }) {
  const { state, dispatch } = useStore();
  const workspace = useWorkspace();
  useTabKinds();
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const [outputsOpen, setOutputsOpen] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [createMenu, setCreateMenu] = useState<MenuAnchor | null>(null);
  const [rename, setRename] = useState<string | null>(null);
  const [schedule, setSchedule] = useState(false);
  const [status, setStatus] = useState("");
  const [pinVersion, setPinVersion] = useState(0);
  const resources = useMemo(() => conversationResources(messages), [messages]);
  const popover = useRef<HTMLDivElement>(null);
  const renameRef = useRef<HTMLDialogElement>(null);
  const task = bot.tasks?.find(task => task.threadId === bot.threadId);
  const title = task?.title ?? bot.name;
  const key = `bos-thread-pins:${bot.id}`;
  const readPins = () => { try { const value: unknown = JSON.parse(localStorage.getItem(key) ?? "[]"); return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : []; } catch { return []; } };
  const pinned = useMemo(() => readPins().includes(bot.threadId), [key, bot.threadId, pinVersion]); // storage is shared with the sidebar
  const pin = () => {
    const pins = readPins();
    try { localStorage.setItem(key, JSON.stringify(pins.includes(bot.threadId) ? pins.filter(id => id !== bot.threadId) : [...pins, bot.threadId])); window.dispatchEvent(new Event(PIN_EVENT)); }
    catch { setStatus("Could not save pin"); }
  };
  const copy = async (value: string) => setStatus(await copyTranscriptToClipboard(value) ? "Copied" : "Could not copy to clipboard");
  useEffect(() => { const refresh = () => setPinVersion(v => v + 1); window.addEventListener(PIN_EVENT, refresh); window.addEventListener("storage", refresh); return () => { window.removeEventListener(PIN_EVENT, refresh); window.removeEventListener("storage", refresh); }; }, []);
  useEffect(() => {
    if (!outputsOpen) return;
    const close = (event: PointerEvent) => { if (event.target instanceof Element && !popover.current?.contains(event.target) && !event.target.closest("[data-workbench-menu]")) { setOutputsOpen(false); setCreateMenu(null); } };
    const keydown = (event: KeyboardEvent) => { if (event.key === "Escape" && !createMenu) { setOutputsOpen(false); } };
    window.addEventListener("pointerdown", close); window.addEventListener("keydown", keydown);
    return () => { window.removeEventListener("pointerdown", close); window.removeEventListener("keydown", keydown); };
  }, [outputsOpen, createMenu]);
  useEffect(() => { if (rename !== null && !renameRef.current?.open) renameRef.current?.showModal(); }, [rename]);
  useEffect(() => {
    if (!local || !task) return;
    const keydown = (event: KeyboardEvent) => {
      // A side conversation must not act on the primary conversation's shortcut.
      if (workspace.target?.botId !== bot.id || workspace.target?.threadId !== bot.threadId || event.defaultPrevented || event.repeat) return;
      const mac = window.ogb?.platform === "darwin" || /mac/i.test(navigator.platform);
      const mod = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      if (!mod) return;
      if (event.altKey && !event.shiftKey && event.code === "KeyR") { event.preventDefault(); setRename(title); }
      else if (event.altKey && !event.shiftKey && event.code === "KeyP") { event.preventDefault(); pin(); }
      else if (event.altKey && !event.shiftKey && event.code === "KeyL") { event.preventDefault(); void copy(threadRefUrl({ botId: bot.id, threadId: bot.threadId })); }
      else if (!event.altKey && event.shiftKey && event.code === "KeyC" && bot.cwd) { event.preventDefault(); void copy(bot.cwd); }
      else if (!event.altKey && event.shiftKey && event.code === "KeyA" && !bot.busy) { event.preventDefault(); dispatch({ type: "updateTask", botId: bot.id, threadId: bot.threadId, patch: { archivedAt: task.archivedAt ? null : Date.now() } }); }
    };
    window.addEventListener("keydown", keydown); return () => window.removeEventListener("keydown", keydown);
  });
  if (!local) return <ConversationTools>{children}</ConversationTools>;
  const mac = window.ogb?.platform === "darwin" || /mac/i.test(navigator.platform);
  const keys = (macKeys: string, other: string) => mac ? macKeys : other;
  const entries: MenuEntry[] = [
    ...(task ? [
      { key: "rename", label: "Rename", shortcut: keys("⌥⌘R", "Ctrl Alt R"), onSelect: () => setRename(title) },
      { key: "pin", label: pinned ? "Unpin" : "Pin", shortcut: keys("⌥⌘P", "Ctrl Alt P"), onSelect: pin },
    ] : []),
    ...(workspace.available ? [{ key: "sidechat", label: "New side chat", shortcut: keys("⌥⌘S", "Ctrl Alt S"), onSelect: () => { workspace.show({ botId: bot.id, threadId: bot.threadId, name: bot.name }); runWorkspaceCommand("workspace-sidechat"); } }] : []),
    { key: "schedule", label: "Add scheduled task…", onSelect: () => setSchedule(true) },
    { type: "separator", key: "copy-divider" },
    { key: "copy", label: "Copy", submenu: [
      { key: "link", label: "Copy deeplink", shortcut: keys("⌥⌘L", "Ctrl Alt L"), onSelect: () => void copy(threadRefUrl({ botId: bot.id, threadId: bot.threadId })) },
      { key: "markdown", label: "Copy as Markdown", onSelect: () => void copy(formatTranscriptMarkdown({ title, messages, botName: bot.name })) },
      ...(bot.cwd ? [{ key: "cwd", label: "Copy working directory", shortcut: keys("⇧⌘C", "Ctrl Shift C"), onSelect: () => void copy(bot.cwd!) }] : []),
    ] },
    ...(task ? [{ key: "archive", label: task.archivedAt ? "Unarchive" : "Archive", disabled: Boolean(bot.busy), shortcut: keys("⇧⌘A", "Ctrl Shift A"), icon: Archive, onSelect: () => dispatch({ type: "updateTask", botId: bot.id, threadId: bot.threadId, patch: { archivedAt: task.archivedAt ? null : Date.now() } }) }] : []),
    { type: "separator", key: "bos-divider" },
    { type: "custom", key: "bos-tools", render: () => <div className="conversation-tools"><div role="group" aria-label="More tools" className="flex flex-col gap-1">{children}</div></div> },
  ];
  // a bot browsing for another thread says where, instead of taking this pane
  const browsing = workspace.botBrowsing && workspace.botBrowsing.threadId !== bot.threadId ? workspace.botBrowsing : null;
  const browsingOwner = browsing && (state.groups.find(group => group.threadId === browsing.threadId || group.tasks?.some(task => task.threadId === browsing.threadId)) ?? state.bots.find(candidate => candidate.id === browsing.botId));
  const browsingTitle = browsing && browsingOwner ? (browsingOwner.tasks?.find(task => task.threadId === browsing.threadId)?.title ?? browsingOwner.name) : "another thread";
  const browsingBot = browsing ? state.bots.find(candidate => candidate.id === browsing.botId)?.name ?? "A bot" : "";
  const page = tabKind("page");
  const canCreatePage = workspace.available && page && !page.placeholder;
  return <>
    {browsing && <button type="button" title={`${browsingBot} is browsing in ${browsingTitle}. Open that thread`} aria-label={`${browsingBot} is browsing in ${browsingTitle}. Open that thread`}
      className="flex h-7 min-w-0 max-w-[13rem] items-center gap-1.5 rounded-full border border-hairline px-2.5 text-[12px] text-ink/70 transition-colors hover:bg-ink/[.078] hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
      onClick={() => openThread(dispatch, browsing, state)}><Globe size={13} className="shrink-0" /><span className="truncate">Browsing in {browsingTitle}</span></button>}
    <button type="button" aria-label="Conversation options" aria-haspopup="menu" aria-expanded={Boolean(menu)} title="Conversation options" className={ICON} onClick={event => { setOutputsOpen(false); setMenu(anchorOf(event.currentTarget)); }}><MoreHorizontal size={18} /></button>
    {menu && <Menu anchor={menu} entries={entries} label="Conversation options" align="end" onClose={() => setMenu(null)} />}
    <div ref={popover} className="relative">
      <button type="button" aria-label="Outputs and sources" aria-haspopup="dialog" aria-expanded={outputsOpen} title="Outputs and sources" className={ICON} onClick={() => { setMenu(null); setOutputsOpen(value => !value); }}><Layers size={18} /></button>
      {outputsOpen && <div role="dialog" aria-label="Outputs and sources" className="absolute end-0 top-full z-40 mt-2 flex max-h-[28rem] w-80 max-w-[calc(100vw-2rem)] flex-col overflow-y-auto rounded-2xl border border-ink/[.084] bg-menu p-2 shadow-xl">
        <div className="flex h-8 shrink-0 items-center justify-between px-2.5 text-[13px] font-medium">Outputs{canCreatePage && <button type="button" aria-label="Create a file or site" title="Create a file or site" className={ICON} onClick={event => setCreateMenu(anchorOf(event.currentTarget))}><Plus size={16} /></button>}</div>
        {resources.outputs.length === 0 ? <p className="px-2.5 py-5 text-[13px] text-ink/50">No outputs found</p> : resources.outputs.map(file => <div key={file.path} className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] hover:bg-ink/[.078]"><FileText size={16} className="shrink-0 text-ink/70" /><ChatMarkdown message={{ threadId: bot.threadId, messageId: file.message.id }} text={`[${file.name.replace(/[[\]\\]/g, "")}](${("file://" + (file.path.startsWith("/") ? "" : "/") + encodeURI(file.path.replace(/\\/g, "/")).replace(/[?#()]/g, c => "%" + c.charCodeAt(0).toString(16)))})`} /></div>)}
        {resources.sources.length > 0 && <><div className="mx-2 my-1.5 h-px shrink-0 bg-ink/[.084]" /><button type="button" onClick={() => setSourcesOpen(value => !value)} className="flex h-8 shrink-0 items-center gap-2 rounded-lg px-2.5 text-[13px] hover:bg-ink/[.078]" aria-expanded={sourcesOpen}><span className="flex-1 text-left">Sources · {resources.sources.length}</span><ChevronRight size={15} className={sourcesOpen ? "rotate-90" : ""} /></button>{sourcesOpen && resources.sources.map(source => <a key={source.url} href={source.url} target="_blank" rel="noreferrer" className="truncate rounded-lg px-2.5 py-2 text-[13px] text-ink/70 hover:bg-ink/[.078]" title={source.url}>{source.name}</a>)}</>}
      </div>}
    </div>
    {createMenu && <Menu anchor={createMenu} label="Create a file or site" align="end" onClose={() => setCreateMenu(null)} entries={canCreatePage ? [{ key: "document", label: "Create document", icon: FileText, onSelect: () => { workspace.show({ botId: bot.id, threadId: bot.threadId, name: bot.name }); workspace.openTab("page", { fresh: true, pane: "right" }); workspace.setLayout("split"); setOutputsOpen(false); } }] : []} />}
    {workspace.available && !rightVisible(workspace.workspace) && <><span aria-hidden="true" className="mx-0.5 h-4 w-px bg-ink/[.084]" /><button type="button" aria-label="New tab" title="New tab" className={ICON} onClick={() => { workspace.show({ botId: bot.id, threadId: bot.threadId, name: bot.name }); runWorkspaceCommand("workspace-new-tab"); }}><Plus size={19} /></button></>}
    {status && <span role="status" className="sr-only">{status}</span>}
    {rename !== null && <dialog ref={renameRef} onCancel={() => setRename(null)} onClose={() => setRename(null)} className="w-96 max-w-[calc(100vw-2rem)] rounded-2xl border border-hairline bg-card p-5 text-ink shadow-xl backdrop:bg-black/50"><form onSubmit={event => { event.preventDefault(); if (!rename.trim()) return; dispatch({ type: "renameTask", botId: bot.id, threadId: bot.threadId, title: rename.trim() }); setRename(null); }}><div className="mb-4 flex items-center justify-between"><h2 className="font-medium">Rename conversation</h2><button type="button" className={ICON} aria-label="Cancel rename" onClick={() => setRename(null)}><X size={16} /></button></div><input autoFocus aria-label="Conversation name" value={rename} onFocus={event => event.currentTarget.select()} onChange={event => setRename(event.target.value)} className="w-full rounded-lg border border-hairline bg-inset px-3 py-2 text-sm outline-accent" /><div className="mt-4 flex justify-end gap-2"><button type="button" className="rounded-lg px-3 py-2 text-sm hover:bg-raised" onClick={() => setRename(null)}>Cancel</button><button type="submit" disabled={!rename.trim()} className="rounded-lg bg-ink px-3 py-2 text-sm text-app disabled:opacity-40">Save</button></div></form></dialog>}
    {schedule && <RoutineEditor bots={state.bots} lockedBotId={bot.id} onClose={() => setSchedule(false)} />}
  </>;
}
