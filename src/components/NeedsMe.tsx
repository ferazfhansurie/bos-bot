// "Needs me": everything waiting on the person, plus what moved in the last
// day. The sidebar row carries the live count; the page refetches whenever
// that count changes (the server's `inbox` frame).
import { useEffect, useState } from "react";
import { BellDot, CheckCheck, CheckCircle2, CircleAlert, CircleHelp, Inbox, Loader2, X, XCircle } from "lucide-react";
import { openThread, useStore, type AppState } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { BotAvatar } from "./Avatar";
import {
  DIGEST_WINDOW_MS,
  answerInboxItem,
  clearInbox,
  digestChangeLabel,
  digestCountEntries,
  fetchDigest,
  fetchInbox,
  groupInboxItems,
  inboxBadge,
  inboxItemAnswerable,
  inboxItemClearable,
  inboxKindLabel,
  inboxRelativeTime,
  type DigestMove,
  type DigestResponse,
  type InboxAnswer,
  type InboxItem,
  type InboxKind,
  type InboxResponse,
} from "@/lib/inbox";
import type { SidebarDensity } from "@/lib/sidebar-preferences";

const KIND_ICON: Record<InboxKind, typeof Inbox> = {
  "waiting-on-you": CircleAlert,
  question: CircleHelp,
  failed: XCircle,
  unread: BellDot,
};

const KIND_TONE: Record<InboxKind, string> = {
  "waiting-on-you": "text-warning",
  question: "text-accent",
  failed: "text-danger",
  unread: "text-ink-secondary",
};

export function NeedsMeNavRow({ density }: { density: SidebarDensity }) {
  const { state, dispatch } = useStore();
  const active = state.activeView === "needs-me";
  const badge = inboxBadge(state.inboxCount);
  const icons = density === "icons";
  return (
    <div className={cn("pb-2", icons ? "px-2" : "px-3")}>
      <button
        type="button"
        data-sidebar-needs-me
        onClick={() => dispatch({ type: "showNeedsMe" })}
        aria-label={badge ? t("needsMe.navCount", { count: state.inboxCount }) : t("needsMe.title")}
        title={icons ? t("needsMe.title") : undefined}
        className={cn(
          "relative flex min-h-9 w-full items-center rounded-xl py-1.5 text-left transition-colors",
          icons ? "justify-center px-2" : "gap-3 px-3",
          active ? "bg-raised text-ink" : "text-ink hover:bg-raised/50",
        )}
      >
        <Inbox size={18} className={active ? "text-accent" : "text-ink-secondary"} />
        {!icons && <span className="flex-1 text-[14px]">{t("needsMe.title")}</span>}
        {badge && (
          <span className={cn(
            "flex min-w-4 items-center justify-center rounded-full bg-accent px-1 font-semibold text-ink",
            icons ? "absolute right-1 top-0.5 text-[9.5px] leading-4" : "text-[11px] leading-[18px]",
          )}>{badge}</span>
        )}
      </button>
    </div>
  );
}

/** Bot (and room, when it happened in one) a row belongs to. */
function owners(state: AppState, row: { botId: string; groupId?: string }) {
  const bot = state.bots.find((candidate) => candidate.id === row.botId);
  const group = row.groupId ? state.groups.find((candidate) => candidate.id === row.groupId) : undefined;
  const name = [bot?.name, group?.name].filter(Boolean).join(" · ");
  return { bot, name };
}

export function NeedsMePage() {
  const { state, dispatch } = useStore();
  const [inbox, setInbox] = useState<InboxResponse | null>(null);
  const [digest, setDigest] = useState<DigestResponse | null>(null);
  // a local bump refetches after a clear or an answer without waiting on
  // the server's debounced count frame
  const [reload, setReload] = useState(0);
  // row ids with a clear or answer in flight; "*" is clear all
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  // the count is the change signal; the list itself always comes fresh
  useEffect(() => {
    let alive = true;
    fetchInbox().then((next) => {
      if (!alive) return;
      setInbox(next);
      dispatch({ type: "inboxCount", count: next.count });
    }, () => { if (alive) setInbox((current) => current ?? { items: [], count: 0 }); });
    return () => { alive = false; };
  }, [state.inboxCount, reload, dispatch]);

  useEffect(() => {
    let alive = true;
    fetchDigest(Date.now() - DIGEST_WINDOW_MS).then((next) => { if (alive) setDigest(next); }, () => {});
    return () => { alive = false; };
  }, []);

  const open = (row: { botId: string; threadId: string }) =>
    openThread(dispatch, { botId: row.botId, threadId: row.threadId }, state);

  /** One in-flight action per key; a failure stays on the page, not a toast. */
  const run = (key: string, work: () => Promise<unknown>, failure: "needsMe.clearFailed" | "needsMe.answerFailed") => {
    if (busy.has(key) || busy.has("*")) return;
    setBusy((current) => new Set(current).add(key));
    setError(null);
    work()
      .catch((cause) => setError(t(failure, { error: cause instanceof Error ? cause.message : String(cause) })))
      .finally(() => {
        setBusy((current) => { const next = new Set(current); next.delete(key); return next; });
        setReload((n) => n + 1);
      });
  };
  const clear = (ids?: string[]) => run(ids?.[0] ?? "*", async () => {
    if (!(await clearInbox(ids))) setError(t("needsMe.unsupported"));
  }, "needsMe.clearFailed");
  const answer = (item: InboxItem, choice: InboxAnswer) => run(item.id, () => answerInboxItem(item, choice), "needsMe.answerFailed");

  const groups = groupInboxItems(inbox?.items ?? []);
  const clearable = inbox?.items.some(inboxItemClearable) ?? false;
  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-app text-ink">
      <header className="flex shrink-0 items-center gap-2.5 border-b border-hairline/40 px-6 py-4 max-md:pl-12">
        <Inbox size={18} className="text-ink-secondary" />
        <h1 className="text-[17px] font-semibold">{t("needsMe.title")}</h1>
        {inbox && inbox.count > 0 && <span className="ml-1 text-[11px] text-ink-secondary">{inbox.count}</span>}
        {clearable && (
          <button
            type="button"
            data-needs-me-clear-all
            onClick={() => clear()}
            disabled={busy.has("*")}
            title={t("needsMe.clearAllHint")}
            className="ml-auto flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[12.5px] text-ink-secondary hover:bg-raised/50 hover:text-ink disabled:opacity-50"
          >
            {busy.has("*") ? <Loader2 size={14} className="animate-spin" /> : <CheckCheck size={14} />}
            {t("needsMe.clearAll")}
          </button>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-6 py-5">
          {error && <p role="alert" className="px-1 text-[12px] text-danger">{error}</p>}
          {!inbox ? (
            <div className="flex justify-center py-10 text-ink-secondary"><Loader2 size={18} className="animate-spin" /></div>
          ) : groups.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 text-center">
              <CheckCircle2 size={22} className="text-success" />
              <p className="text-[14px] text-ink">{t("needsMe.empty")}</p>
              <p className="text-[12px] text-ink-secondary">{t("needsMe.emptyHint")}</p>
            </div>
          ) : (
            groups.map((group) => (
              <section key={group.kind} className="flex flex-col gap-1">
                <h2 className="px-1 text-[11px] font-medium uppercase tracking-wide text-ink-secondary">
                  {inboxKindLabel(group.kind)} · {group.items.length}
                </h2>
                {group.items.map((item) => (
                  <InboxRow
                    key={item.id}
                    item={item}
                    state={state}
                    busy={busy.has(item.id) || busy.has("*")}
                    onOpen={open}
                    onClear={() => clear([item.id])}
                    onAnswer={(choice) => answer(item, choice)}
                  />
                ))}
              </section>
            ))
          )}
          {digest && <DigestSection digest={digest} state={state} onOpen={open} />}
        </div>
      </div>
    </main>
  );
}

function InboxRow({ item, state, busy, onOpen, onClear, onAnswer }: {
  item: InboxItem;
  state: AppState;
  busy: boolean;
  onOpen: (row: InboxItem) => void;
  onClear: () => void;
  onAnswer: (choice: InboxAnswer) => void;
}) {
  const { bot, name } = owners(state, item);
  const Icon = KIND_ICON[item.kind];
  const kind = inboxKindLabel(item.kind);
  const chip = "rounded-full border border-hairline/50 bg-control px-2.5 py-0.5 text-[12px] text-ink transition-colors hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-50";
  return (
    <div className="group relative rounded-xl hover:bg-raised/50">
      <button
        type="button"
        onClick={() => onOpen(item)}
        aria-label={`${kind}: ${item.title}${name ? ` · ${name}` : ""}`}
        className="flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60"
      >
        {bot ? <BotAvatar bot={bot} size={28} animated={false} /> : <Icon size={18} className={cn("mt-1 shrink-0", KIND_TONE[item.kind])} />}
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink">{item.title || t("needsMe.untitled")}</span>
            {/* the clear (x) takes the time's place on hover */}
            <span className={cn("shrink-0 text-[11px] text-ink-secondary", inboxItemClearable(item) && "group-hover:invisible group-focus-within:invisible")}>{inboxRelativeTime(item.at)}</span>
          </span>
          <span className="flex items-center gap-1.5 text-[11.5px] text-ink-secondary">
            <Icon size={12} aria-hidden="true" className={cn("shrink-0", KIND_TONE[item.kind])} />
            {/* the section heading already names the kind */}
            <span className="min-w-0 truncate">{name || kind}</span>
          </span>
          {item.preview && <span className="mt-0.5 line-clamp-2 block text-[12.5px] text-ink-secondary">{item.preview}</span>}
        </span>
      </button>
      {/* a live approval has no clear: only an answer settles it */}
      {inboxItemClearable(item) && (
        <button
          type="button"
          data-needs-me-clear
          onClick={onClear}
          disabled={busy}
          aria-label={`${t("needsMe.clearRow")}: ${item.title || t("needsMe.untitled")}`}
          title={t("needsMe.clearRow")}
          className="absolute right-2 top-2 rounded-md p-1 text-ink-secondary opacity-0 hover:bg-control hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 disabled:opacity-50 max-md:opacity-100"
        >
          <X size={14} />
        </button>
      )}
      {inboxItemAnswerable(item) && (
        <div className="flex flex-wrap gap-1.5 pb-2.5 pl-[52px] pr-3">
          {item.approval ? (
            <>
              <button type="button" disabled={busy} onClick={() => onAnswer({ behavior: "allow" })} className={chip}>{t("approval.action.allowOnce")}</button>
              <button type="button" disabled={busy} onClick={() => onAnswer({ behavior: "deny" })} className={chip}>{t("approval.action.deny")}</button>
            </>
          ) : (
            item.options?.map((option) => (
              <button key={option} type="button" disabled={busy} onClick={() => onAnswer({ option })} className={cn(chip, "max-w-full truncate")}>{option}</button>
            ))
          )}
          {busy && <Loader2 size={14} className="mt-1 animate-spin text-ink-secondary" />}
        </div>
      )}
    </div>
  );
}

function DigestSection({ digest, state, onOpen }: { digest: DigestResponse; state: AppState; onOpen: (row: DigestMove) => void }) {
  return (
    <section className="flex flex-col gap-2 border-t border-hairline/40 pt-5">
      <h2 className="px-1 text-[11px] font-medium uppercase tracking-wide text-ink-secondary">{t("needsMe.digest.title")}</h2>
      <div className="flex flex-wrap gap-2 px-1">
        {digestCountEntries(digest.counts).map((entry) => (
          <span key={entry.key} className="rounded-lg bg-raised/50 px-2.5 py-1 text-[12px] text-ink-secondary">
            <span className="font-semibold text-ink">{entry.value}</span> {entry.label}
          </span>
        ))}
      </div>
      {digest.moved.length === 0 ? (
        <p className="px-1 text-[12px] text-ink-secondary">{t("needsMe.digest.quiet")}</p>
      ) : (
        <div className="flex flex-col gap-0.5">
          {digest.moved.map((move) => {
            const { bot, name } = owners(state, move);
            return (
              <button
                key={`${move.threadId}:${move.change}:${move.at}`}
                type="button"
                onClick={() => onOpen(move)}
                className="flex w-full items-start gap-3 rounded-xl px-3 py-2 text-left hover:bg-raised/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60"
              >
                {bot && <BotAvatar bot={bot} size={22} animated={false} />}
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{move.title || t("needsMe.untitled")}</span>
                    <span className={cn("shrink-0 text-[11px]", move.change === "failed" ? "text-danger" : "text-ink-secondary")}>{digestChangeLabel(move.change)}</span>
                  </span>
                  <span className="block truncate text-[11.5px] text-ink-secondary">
                    {[name, move.summary].filter(Boolean).join(" · ")}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
