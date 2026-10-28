// The top of the 3.0 today screen: what the chief's check-ins put in front of
// the person, one tap each. Go ahead starts a fresh thread on the bot that
// owns the item; not now brings it back at 9 tomorrow; no is remembered.
import { useState, type ReactNode } from "react";
import { checkinOwnerBotId, type CheckinAction, type CheckinItem, type CheckinKind, type CheckinSource, type CheckinsSnapshot } from "../../shared/checkins";
import { actOnCheckin, greetingFor, nextCheckinAt, openItems, setupCheckins, useCheckins } from "@/lib/checkins";
import { openExternalLink } from "@/lib/app-links";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import type { LocaleKey } from "@/locales";

const KIND_LABEL: Record<CheckinKind, LocaleKey> = {
  did: "v3.today.kind.did",
  broke: "v3.today.kind.broke",
  decide: "v3.today.kind.decide",
  tonight: "v3.today.kind.tonight",
};

const KIND_TONE: Record<CheckinKind, string> = {
  did: "bg-success/15 text-success",
  broke: "bg-danger/15 text-danger",
  decide: "bg-warning/20 text-ink",
  tonight: "bg-accent/15 text-accent",
};

/** The buttons an item offers, primary first. A "did" report only needs an ack. */
export function checkinButtons(item: Pick<CheckinItem, "kind" | "draft">): { action: CheckinAction; label: LocaleKey }[] {
  if (item.kind === "did") return [{ action: "done", label: "v3.today.gotIt" }, { action: "no", label: "v3.today.no" }];
  return [
    { action: "approve", label: item.kind === "broke" ? "v3.today.fixIt" : item.draft ? "v3.today.send" : "v3.today.goAhead" },
    { action: "done", label: "v3.today.done" },
    { action: "not-now", label: "v3.today.notNow" },
    { action: "no", label: "v3.today.no" },
  ];
}

function time(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function KindBadge({ kind }: { kind: CheckinKind }) {
  return <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium", KIND_TONE[kind])}>{t(KIND_LABEL[kind])}</span>;
}

export function CheckinButtons({ item, busy, onAct }: { item: CheckinItem; busy: boolean; onAct: (action: CheckinAction) => void }) {
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label={item.title}>
      {checkinButtons(item).map(({ action, label }, index) => (
        <button key={action} type="button" disabled={busy} data-checkin-action={action} onClick={() => onAct(action)}
          className={cn("h-8 rounded-full px-3.5 text-[13px] font-medium outline-none focus-visible:ring-1 focus-visible:ring-hairline disabled:opacity-50",
            index === 0 ? "bg-ink text-app hover:opacity-90" : "bg-raised text-ink hover:bg-raised/70")}>
          {t(label)}
        </button>
      ))}
    </div>
  );
}

function SourceLink({ source, onOpenThread }: { source: CheckinSource; onOpenThread?: (botId: string | undefined, threadId: string) => void }) {
  const label = source.label || (source.type === "url" ? source.ref : t(`v3.today.source.${source.type}` as LocaleKey));
  const href = source.url || (source.type === "url" ? source.ref : "");
  if (source.type === "thread" && onOpenThread) {
    return <button type="button" onClick={() => onOpenThread(source.botId, source.ref)} className="underline decoration-hairline underline-offset-2 hover:text-ink">{label}</button>;
  }
  if (href) return <button type="button" onClick={() => void openExternalLink(href)} className="underline decoration-hairline underline-offset-2 hover:text-ink">{label}</button>;
  return <span>{label}</span>;
}

export function CheckinRow({ item, expanded, busy, avatar, owner, onToggle, onAct, onOpenThread }: {
  item: CheckinItem;
  expanded: boolean;
  busy: boolean;
  avatar?: ReactNode;
  owner?: string;
  onToggle: () => void;
  onAct: (action: CheckinAction) => void;
  onOpenThread?: (botId: string | undefined, threadId: string) => void;
}) {
  return (
    <li className={cn("rounded-2xl border border-hairline/40 bg-panel", expanded && "border-hairline/70")} data-checkin-item={item.id}>
      <button type="button" aria-expanded={expanded} onClick={onToggle} className="flex w-full items-center gap-3 px-3 py-2.5 text-left outline-none focus-visible:ring-1 focus-visible:ring-hairline rounded-2xl">
        <span className={cn("size-4 shrink-0 rounded-full border-2", item.kind === "broke" ? "border-danger" : item.kind === "decide" ? "border-warning" : "border-hairline")} aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14px] font-medium text-ink">{item.title}</span>
          {!expanded && <span className="block truncate text-[12px] text-ink-secondary">{owner ? `${owner} · ` : ""}{item.why}</span>}
        </span>
        <KindBadge kind={item.kind} />
        {avatar}
      </button>
      {expanded && (
        <div className="space-y-3 px-3 pb-3 pl-10">
          <p className="text-[13px] leading-5 text-ink-secondary">{item.why}</p>
          {item.plan && <p className="text-[13px] leading-5 text-ink"><span className="text-ink-secondary">{t("v3.today.plan")} </span>{item.plan}</p>}
          {item.draft && <blockquote className="whitespace-pre-wrap rounded-xl bg-raised/60 px-3 py-2 text-[13px] leading-5 text-ink">{item.draft}</blockquote>}
          {item.sources.length > 0 && (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-ink-secondary">
              <span>{owner ? t("v3.today.fromOwner", { name: owner }) : t("v3.today.from")}</span>
              {item.sources.map((source) => <SourceLink key={`${source.type}:${source.ref}`} source={source} onOpenThread={onOpenThread} />)}
            </div>
          )}
          <CheckinButtons item={item} busy={busy} onAct={onAct} />
        </div>
      )}
    </li>
  );
}

export function CheckinCounts({ snapshot }: { snapshot: CheckinsSnapshot }) {
  const { later, done, no } = snapshot.counts;
  if (!later && !done && !no) return null;
  return (
    <p className="px-1 text-[12px] tabular-nums text-ink-secondary" data-testid="checkin-counts">
      {t("v3.today.counts", { later, done, no })}
    </p>
  );
}

/** The headline + list for the today screen. Bots come from the caller so
 * this stays free of the store (the chat card reuses the rows). */
export function CheckinBrief({ name, avatarFor, ownerName, onOpenThread }: {
  name?: string;
  avatarFor: (botId: string) => ReactNode;
  ownerName: (botId: string) => string | undefined;
  onOpenThread: (botId: string, threadId: string) => void;
}) {
  const { snapshot, busy, error } = useCheckins(true);
  const [picked, setPicked] = useState<string | null>(null);
  const [settingUp, setSettingUp] = useState(false);
  const now = Date.now();
  const items = openItems(snapshot);
  // null = the default (top item open), "" = the person closed them all
  const expanded = picked === "" ? null : picked && items.some((item) => item.id === picked) ? picked : items[0]?.id ?? null;
  const next = nextCheckinAt(snapshot, now);
  const greeting = name ? t(`v3.today.greetName.${greetingFor(now)}` as LocaleKey, { name }) : t(`v3.today.greeting.${greetingFor(now)}` as LocaleKey);
  const headline = items.length === 1 ? t("v3.today.needOne") : items.length ? t("v3.today.needCount", { count: items.length }) : t("v3.today.nothing");
  const done = snapshot?.counts.done ?? 0;

  return (
    <section className="mb-8" aria-label={t("v3.sidebar.today")} data-testid="checkin-brief">
      <header className="mb-4 px-1">
        <h1 className="text-[26px] font-semibold tracking-tight text-ink">{greeting} <span className="text-ink-secondary">{headline}</span></h1>
        {snapshot?.setUp && (
          <p className="mt-1 text-[13px] text-ink-secondary">
            {[next ? t("v3.today.nextLook", { time: time(next) }) : "", done ? t("v3.today.doneSince", { count: done }) : ""].filter(Boolean).join(" · ")}
          </p>
        )}
      </header>
      {snapshot && !snapshot.setUp && (
        <div className="mb-4 flex items-center gap-3 rounded-2xl border border-hairline/40 bg-panel px-4 py-3" data-testid="checkin-setup">
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-medium text-ink">{t("v3.today.setupTitle")}</div>
            <div className="text-[12px] text-ink-secondary">{snapshot.chiefBotId ? t("v3.today.setupBody") : t("v3.today.setupNoChief")}</div>
          </div>
          {snapshot.chiefBotId && (
            <button type="button" disabled={settingUp} onClick={() => { setSettingUp(true); void setupCheckins().finally(() => setSettingUp(false)); }}
              className="h-8 shrink-0 rounded-full bg-ink px-3.5 text-[13px] font-medium text-app hover:opacity-90 disabled:opacity-50">
              {t("v3.today.setup")}
            </button>
          )}
        </div>
      )}
      {items.length > 0 && (
        <ul className="mb-3 space-y-2">
          {items.map((item) => (
            <CheckinRow key={item.id} item={item} expanded={item.id === expanded} busy={busy.has(item.id)}
              avatar={avatarFor(checkinOwnerBotId(item))} owner={ownerName(checkinOwnerBotId(item))}
              onToggle={() => setPicked(item.id === expanded ? "" : item.id)}
              onAct={(action) => void actOnCheckin(item.id, action)}
              onOpenThread={(botId, threadId) => onOpenThread(botId ?? item.botId, threadId)} />
          ))}
        </ul>
      )}
      {snapshot && <CheckinCounts snapshot={snapshot} />}
      {error && <p className="px-1 text-[12px] text-danger" role="alert">{error}</p>}
    </section>
  );
}
