// ⌘K switcher: bots and rooms from local state, transcript hits from
// /api/search. Self-contained — owns its open state and its global chord,
// so App.tsx only mounts it.
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  CalendarDays,
  Inbox,
  Keyboard,
  Loader2,
  MessageSquare,
  Network,
  Plus,
  Puzzle,
  Search,
  Settings,
  Users,
  type LucideIcon,
} from "lucide-react";
import { api, useStore, visibleMessages, type Bot, type Group } from "@/state/store";
import {
  bestTier,
  highlightRuns,
  rankMatches,
  recentFirst,
  type PaletteMatch,
  type Ranked,
} from "@/lib/palette-rank";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { lastNonReceipt } from "@/lib/receipts";
import type { SearchHit } from "@/lib/search-hit";
import { landOnSearchHit } from "@/lib/focus-message";
import { botAvatarProfile } from "../../shared/bot-avatar";
import { BotAvatar, PersonPhoto } from "./Avatar";
import { shortcutLabel } from "./ShortcutHint";

// enough to cover "the last few things I was in" without pushing the full
// lists below the fold
const RECENT_LIMIT = 6;
const AVATAR = 22;

interface PaletteAction {
  id: string;
  label: string;
  // extra words people type for the same thing; matched like a bot's title
  keywords: string;
  icon: LucideIcon;
  hint?: string;
  run: () => void;
}

type PaletteEntry =
  | { kind: "bot"; bot: Bot; match: PaletteMatch | null }
  | { kind: "room"; group: Group; match: PaletteMatch | null }
  | { kind: "action"; action: PaletteAction; match: PaletteMatch | null }
  | { kind: "message"; hit: SearchHit };

interface Section {
  id: string;
  label: string;
  entries: PaletteEntry[];
}

// same "last message a person would read" the sidebar sorts by, so the
// palette's Recent agrees with what the sidebar shows on top
const botActivityAt = (bot: Bot) => lastNonReceipt(visibleMessages(bot))?.at ?? 0;
const roomActivityAt = (group: Group) =>
  Math.max(lastNonReceipt(group.messages)?.at ?? 0, ...(group.tasks ?? []).map((task) => task.lastActivityAt ?? 0));

function Highlighted({ text, match, field }: { text: string; match: PaletteMatch | null; field: "name" | "title" }) {
  const runs = highlightRuns(text, match?.field === field ? match.indices : undefined);
  return (
    <>
      {runs.map((run, i) =>
        run.hit ? (
          <mark key={i} className="bg-transparent font-semibold text-accent">
            {run.text}
          </mark>
        ) : (
          <span key={i}>{run.text}</span>
        ),
      )}
    </>
  );
}

/** The sidebar's room face, shrunk: the room photo, else its members. */
function RoomFace({ group, members }: { group: Group; members: Bot[] }) {
  const photo = !group.dm ? botAvatarProfile({ avatarUrl: group.avatarUrl }).avatarUrl : undefined;
  if (photo) return <PersonPhoto src={photo} size={AVATAR} />;
  if (members.length === 0) {
    return (
      <span className="flex size-[22px] shrink-0 items-center justify-center rounded-md bg-raised">
        <Users size={13} className="text-ink-secondary" />
      </span>
    );
  }
  if (members.length === 1) return <BotAvatar bot={members[0]!} state="happy" size={AVATAR} animated={false} />;
  return (
    <span className="relative block size-[22px] shrink-0">
      <span className="absolute left-0 top-0">
        <BotAvatar bot={members[0]!} state="happy" size={15} animated={false} />
      </span>
      <span className="absolute bottom-0 right-0">
        <BotAvatar bot={members[1]!} state="happy" size={15} animated={false} />
      </span>
    </span>
  );
}

/** Right-hand status: what's happening there now beats "you've seen it". */
function Status({ waiting, working, unread, current }: { waiting?: boolean; working?: string | false; unread?: boolean; current?: boolean }) {
  if (waiting) return <span className="shrink-0 text-[11.5px] text-warning">{t("task.waiting")}</span>;
  if (working) {
    return (
      <span className="flex shrink-0 items-center gap-1.5 text-[11.5px] text-ink-secondary">
        <span className="size-1.5 rounded-full bg-success motion-safe:animate-pulse" />
        {working}
      </span>
    );
  }
  if (current) return <span className="shrink-0 text-[11.5px] text-ink-secondary">Current</span>;
  if (unread) return <span className="size-2 shrink-0 rounded-full bg-accent" aria-label="Unread" />;
  return null;
}

export function CommandPalette({ onOpenChange }: { onOpenChange?: (open: boolean) => void }) {
  const { state, dispatch } = useStore();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [messageHits, setMessageHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [cursor, setCursor] = useState(0);
  const selectedRef = useRef<HTMLDivElement>(null);
  const idBase = useId();
  const listId = `${idBase}-list`;
  const optionId = (index: number) => `${idBase}-opt-${index}`;

  // The chord fires from anywhere — Shell's app-wide shortcuts (⌘N, ⌘1–9)
  // set the precedent of not guarding against focused inputs, and a
  // modifier chord never collides with typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // fresh palette every open; stale queries from last time would flash
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setMessageHits([]);
    setSearching(false);
    setCursor(0);
  }, [open]);

  useEffect(() => {
    onOpenChange?.(open);
  }, [onOpenChange, open]);

  const q = query.trim().toLowerCase();

  // Same debounce pattern as the sidebar search: names answer instantly
  // from local state, transcript hits arrive a beat later, and a stale
  // response for an outdated query is dropped.
  useEffect(() => {
    if (!open || !q) {
      setMessageHits([]);
      setSearching(false);
      return;
    }
    // Results for the previous query must not remain clickable while the
    // debounce and request for this query are pending.
    setMessageHits([]);
    setSearching(true);
    let alive = true;
    const timer = setTimeout(() => {
      api(`/api/search?q=${encodeURIComponent(q)}&limit=12`)
        .then((result: { hits?: SearchHit[] }) => alive && setMessageHits(result.hits ?? []))
        .catch(() => alive && setMessageHits([]))
        .finally(() => alive && setSearching(false));
    }, 150);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [open, q]);

  useEffect(() => setCursor(0), [q]);

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [cursor, messageHits]);

  if (!open) return null;

  const currentId = state.activeView === "chat" ? state.selectedId : null;
  const visibleBots = state.bots.filter((b) => !b.hidden);
  const membersOf = (group: Group) =>
    group.memberIds.map((id) => state.bots.find((b) => b.id === id)).filter((b): b is Bot => Boolean(b));

  // only things the app already does from a shortcut or a menu; the palette
  // is another door to them, not a new feature surface
  const actions: PaletteAction[] = [
    { id: "new-bot", label: t("sidebar.newBot"), keywords: "create add hire", icon: Plus, hint: shortcutLabel("new-bot"), run: () => dispatch({ type: "toggleNewBot", open: true }) },
    { id: "settings", label: t("settings.title"), keywords: "preferences options config", icon: Settings, run: () => dispatch({ type: "toggleAppSettings", open: true }) },
    { id: "needs-me", label: t("needsMe.title"), keywords: "inbox waiting approvals", icon: Inbox, run: () => dispatch({ type: "showNeedsMe" }) },
    { id: "automations", label: t("sidebar.nav.automations"), keywords: "routines schedule calendar", icon: CalendarDays, run: () => dispatch({ type: "showRoutines" }) },
    { id: "team-map", label: t("sidebar.nav.teamMap"), keywords: "org chart graph", icon: Network, run: () => dispatch({ type: "showTeamMap" }) },
    { id: "apps", label: t("sidebar.nav.connectedApps"), keywords: "plugins integrations mcp", icon: Puzzle, run: () => dispatch({ type: "togglePlugins", open: true }) },
    { id: "shortcuts", label: "Keyboard shortcuts", keywords: "keys hotkeys help", icon: Keyboard, hint: shortcutLabel("shortcuts-cheat-sheet"), run: () => dispatch({ type: "toggleShortcuts", open: true }) },
  ];

  const botEntry = ({ item, match }: Ranked<Bot>): PaletteEntry => ({ kind: "bot", bot: item, match });
  const roomEntry = ({ item, match }: Ranked<Group>): PaletteEntry => ({ kind: "room", group: item, match });

  let sections: Section[];
  if (!q) {
    // switcher mode: where you just were on top, then everything else by
    // kind. The open conversation is left out of Recent so ↵ right after ⌘K
    // goes somewhere.
    const pool: PaletteEntry[] = [
      ...visibleBots.map((bot): PaletteEntry => ({ kind: "bot", bot, match: null })),
      ...state.groups.map((group): PaletteEntry => ({ kind: "room", group, match: null })),
    ];
    const recent = recentFirst(
      pool.filter((e) => entryId(e) !== currentId),
      (e) => (e.kind === "bot" ? botActivityAt(e.bot) : e.kind === "room" ? roomActivityAt(e.group) : 0),
      RECENT_LIMIT,
    );
    const inRecent = new Set(recent.map(entryId));
    const rest = pool.filter((e) => !inRecent.has(entryId(e)));
    sections = [
      { id: "recent", label: "Recent", entries: recent },
      { id: "bots", label: t("sidebar.section.bots"), entries: rest.filter((e) => e.kind === "bot") },
      { id: "rooms", label: t("sidebar.section.channels"), entries: rest.filter((e) => e.kind === "room" && !e.group.dm) },
      { id: "dms", label: t("sidebar.section.botChats"), entries: rest.filter((e) => e.kind === "room" && e.group.dm) },
    ];
  } else {
    const bots = rankMatches(visibleBots, q, (b) => ({ name: b.name, title: b.title }));
    const rooms = rankMatches(state.groups.filter((g) => !g.dm), q, (g) => ({ name: g.name }));
    const dms = rankMatches(state.groups.filter((g) => g.dm), q, (g) => ({ name: g.name }));
    const acts = rankMatches(actions, q, (a) => ({ name: a.label, title: a.keywords }));
    const ranked = [
      { tier: bestTier(bots), section: { id: "bots", label: t("sidebar.section.bots"), entries: bots.map(botEntry) } },
      { tier: bestTier(rooms), section: { id: "rooms", label: t("sidebar.section.channels"), entries: rooms.map(roomEntry) } },
      { tier: bestTier(dms), section: { id: "dms", label: t("sidebar.section.botChats"), entries: dms.map(roomEntry) } },
      {
        tier: bestTier(acts),
        section: { id: "actions", label: "Actions", entries: acts.map(({ item, match }): PaletteEntry => ({ kind: "action", action: item, match })) },
      },
    ];
    // a section whose best row is an exact prefix outranks one that only
    // fuzzy-matched; ties keep bots → rooms → actions. Messages stay last so
    // their late arrival never shifts the rows above the cursor.
    ranked.sort((a, b) => a.tier - b.tier);
    sections = [
      ...ranked.map((r) => r.section),
      { id: "messages", label: "Messages", entries: messageHits.map((hit): PaletteEntry => ({ kind: "message", hit })) },
    ];
  }
  sections = sections.filter((s) => s.entries.length > 0 || (s.id === "messages" && searching));

  const entries = sections.flatMap((s) => s.entries);
  // hits arriving or rows filtering away can strand the cursor past the end
  const selected = entries.length ? Math.min(cursor, entries.length - 1) : 0;

  const activate = async (entry: PaletteEntry) => {
    if (entry.kind === "message") {
      const hit = entry.hit;
      try {
        await landOnSearchHit(hit, state, dispatch);
      } catch (error) {
        dispatch({ type: "error", message: error instanceof Error ? error.message : String(error) });
      }
    } else if (entry.kind === "action") {
      entry.action.run();
    } else {
      dispatch({ type: "select", id: entry.kind === "bot" ? entry.bot.id : entry.group.id });
    }
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const last = entries.length - 1;
    if (e.key === "Escape") {
      e.preventDefault();
      // shield the window listeners other modals hang their own Esc on
      e.stopPropagation();
      setOpen(false);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor(entries.length ? (selected + 1) % entries.length : 0);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor(entries.length ? (selected - 1 + entries.length) % entries.length : 0);
    } else if ((e.key === "Home" || e.key === "End") && !e.shiftKey && entries.length) {
      // shift+Home/End still selects text in the input
      e.preventDefault();
      setCursor(e.key === "Home" ? 0 : last);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const entry = entries[selected];
      if (entry) void activate(entry);
    }
  };

  const row = (entry: PaletteEntry, index: number, children: ReactNode, twoLine = false) => (
    <div
      key={`${entry.kind}:${entryId(entry)}`}
      id={optionId(index)}
      role="option"
      aria-selected={index === selected}
      ref={index === selected ? selectedRef : undefined}
      onClick={() => void activate(entry)}
      // mousemove, not mouseenter: rows shifting under a resting pointer
      // (hits arriving) must not steal the keyboard selection
      onMouseMove={() => setCursor(index)}
      className={cn(
        "flex w-full cursor-default select-none items-center gap-3 rounded-lg px-2.5 py-1.5 text-left",
        twoLine && "flex-col items-stretch gap-0.5 py-2",
        index === selected ? "bg-raised" : "hover:bg-raised/50",
      )}
    >
      {children}
    </div>
  );

  const renderEntry = (entry: PaletteEntry, index: number) => {
    if (entry.kind === "bot") {
      const { bot, match } = entry;
      return row(
        entry,
        index,
        <>
          <BotAvatar bot={bot} state="happy" size={AVATAR} animated={false} />
          <span className="flex min-w-0 flex-1 items-baseline gap-2">
            <span className="min-w-0 max-w-full shrink-0 truncate text-[13.5px] text-ink">
              <Highlighted text={bot.name} match={match} field="name" />
            </span>
            {bot.title && (
              <span className="min-w-0 truncate text-[12.5px] text-ink-secondary">
                <Highlighted text={bot.title} match={match} field="title" />
              </span>
            )}
          </span>
          <Status
            waiting={bot.activity === "waiting-on-you"}
            working={Boolean(bot.busy) && "Working"}
            unread={bot.unread}
            current={bot.id === currentId}
          />
        </>,
      );
    }
    if (entry.kind === "room") {
      const { group, match } = entry;
      const members = membersOf(group);
      const busyBot = group.busyBotId ? state.bots.find((b) => b.id === group.busyBotId) : undefined;
      return row(
        entry,
        index,
        <>
          <RoomFace group={group} members={members} />
          <span className="flex min-w-0 flex-1 items-baseline gap-2">
            <span className="min-w-0 max-w-full shrink-0 truncate text-[13.5px] text-ink">
              <Highlighted text={group.name} match={match} field="name" />
            </span>
            {!group.dm && members.length > 0 && (
              <span className="min-w-0 truncate text-[12.5px] text-ink-secondary">
                {members.length === 1 ? "1 member" : `${members.length} members`}
              </span>
            )}
          </span>
          <Status
            waiting={busyBot?.activity === "waiting-on-you"}
            working={busyBot ? `${busyBot.name} working` : Boolean(group.working) && "Working"}
            unread={group.unread}
            current={group.id === currentId}
          />
        </>,
      );
    }
    if (entry.kind === "action") {
      const { action, match } = entry;
      const Icon = action.icon;
      return row(
        entry,
        index,
        <>
          <span className="flex size-[22px] shrink-0 items-center justify-center rounded-md bg-raised">
            <Icon size={13} className="text-ink-secondary" />
          </span>
          <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink">
            <Highlighted text={action.label} match={match} field="name" />
          </span>
          {action.hint && (
            <kbd className="shrink-0 rounded border border-hairline/50 px-1.5 py-0.5 font-sans text-[11px] leading-none text-ink-secondary">
              {action.hint}
            </kbd>
          )}
        </>,
      );
    }
    const hit = entry.hit;
    const owner = hit.botId ? state.bots.find((b) => b.id === hit.botId) : undefined;
    const before = hit.snippet.slice(0, hit.matchStart);
    const matched = hit.snippet.slice(hit.matchStart, hit.matchStart + hit.matchLength);
    const after = hit.snippet.slice(hit.matchStart + hit.matchLength);
    return row(
      entry,
      index,
      <>
        <span className="flex items-center gap-2 truncate text-[13px] font-medium text-ink">
          {owner ? (
            <BotAvatar bot={owner} state="happy" size={16} animated={false} />
          ) : (
            <MessageSquare size={13} className="shrink-0 text-ink-secondary" />
          )}
          {hit.name}
          {hit.task ? <span className="font-normal text-ink-secondary"> · {hit.task}</span> : null}
        </span>
        <span className="line-clamp-2 pl-6 text-[12.5px] text-ink-secondary">
          {before}<mark className="rounded-sm bg-accent/25 px-0.5 text-ink">{matched}</mark>{after}
        </span>
      </>,
      true,
    );
  };

  // flat cursor across sections; each row needs its absolute index
  let index = 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-6 pt-[14vh] backdrop-blur-[2px]"
      onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}
      onKeyDown={onKeyDown}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="flex max-h-[min(520px,72vh)] w-full max-w-[600px] flex-col overflow-hidden rounded-xl border border-hairline/50 bg-card shadow-2xl shadow-black/60 motion-safe:animate-pop-in"
      >
        <div className="flex items-center gap-3 border-b border-hairline/40 px-4 py-3">
          <Search size={16} className="shrink-0 text-ink-secondary" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search bots, group chats, messages…"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={entries.length ? optionId(selected) : undefined}
            className="w-full bg-transparent text-[14px] text-ink placeholder:text-ink-secondary focus:outline-none"
          />
        </div>
        <div id={listId} role="listbox" aria-label="Results" className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {sections.length === 0 && (
            <div className="px-3 py-8 text-center text-[13px] text-ink-secondary">
              {q ? `Nothing matches “${query.trim()}”` : "Nothing to switch to yet"}
            </div>
          )}
          {sections.map((section, sectionIndex) => (
            <div key={section.id} role="group" aria-labelledby={`${idBase}-${section.id}`}>
              <div
                id={`${idBase}-${section.id}`}
                role="presentation"
                className={cn(
                  "px-2.5 pb-1 text-[11px] font-medium uppercase tracking-[0.08em] text-ink-secondary",
                  sectionIndex === 0 ? "pt-1.5" : "pt-3",
                )}
              >
                {section.label}
              </div>
              {section.entries.map((entry) => renderEntry(entry, index++))}
              {section.id === "messages" && searching && (
                // a placeholder, not an option: the cursor never lands on it
                <div role="presentation" className="flex items-center gap-2 px-2.5 py-2 text-[12.5px] text-ink-secondary">
                  <Loader2 size={13} className="motion-safe:animate-spin" />
                  Searching messages…
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="flex items-center gap-4 border-t border-hairline/40 px-4 py-2 text-[11.5px] text-ink-secondary">
          <KeyHint keys={["↑", "↓"]} label="navigate" />
          <KeyHint keys={["↵"]} label="open" />
          <KeyHint keys={["esc"]} label="close" />
        </div>
      </div>
    </div>
  );
}

function KeyHint({ keys, label }: { keys: string[]; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="flex gap-0.5">
        {keys.map((key) => (
          <kbd
            key={key}
            className="min-w-[18px] rounded border border-hairline/50 bg-raised/40 px-1 py-0.5 text-center font-sans text-[10.5px] leading-none text-ink-secondary"
          >
            {key}
          </kbd>
        ))}
      </span>
      {label}
    </span>
  );
}

function entryId(entry: PaletteEntry): string {
  switch (entry.kind) {
    case "bot":
      return entry.bot.id;
    case "room":
      return entry.group.id;
    case "action":
      return entry.action.id;
    case "message":
      return `${entry.hit.threadId}:${entry.hit.messageId}`;
  }
}
