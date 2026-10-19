import { useEffect, useRef, useState } from "react";
import { Check, CircleHelp, Clock3, Minus, RefreshCw, TriangleAlert } from "lucide-react";
import { api, type Bot, type InstanceInfo } from "@/state/store";
import type { BotOverview } from "@/lib/bot-overview-types";
import { botReadinessRows, type ReadinessAction } from "@/lib/bot-readiness";

type Snapshot = { instances?: InstanceInfo[]; connections?: BotOverview["connections"]; requirements?: BotOverview["requirements"]; toolAvailability?: BotOverview["toolAvailability"] };
const icons = { ok: Check, action: TriangleAlert, waiting: Clock3, optional: Minus, unknown: CircleHelp };

export function ReadinessPanel({ bot, active, onAction }: {
  bot: Pick<Bot, "id" | "modelSelection" | "composio">;
  active: boolean;
  onAction: (action: ReadinessAction) => void;
}) {
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [checking, setChecking] = useState(true);
  const refresh = useRef<() => void>(() => {});
  // A changed bot or model must never inherit the previous selection's status.
  const identity = JSON.stringify([bot.id, bot.modelSelection.instanceId, bot.composio]);
  const [loadedIdentity, setLoadedIdentity] = useState("");

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const load = async () => {
      if (cancelled || inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      clearTimeout(timer);
      setChecking(true);
      try {
        const [instances, overview] = await Promise.allSettled([
          api<{ instances: InstanceInfo[] }>("/api/instances", { signal: controller.signal, timeoutMs: 12_000 }),
          api<BotOverview>(`/api/bots/${encodeURIComponent(bot.id)}/overview`, { signal: controller.signal, timeoutMs: 12_000 }),
        ]);
        if (cancelled) return;
        const connections = overview.status === "fulfilled" ? overview.value.connections : undefined;
        setSnapshot({ instances: instances.status === "fulfilled" ? instances.value.instances : undefined, connections, requirements: overview.status === "fulfilled" ? overview.value.requirements : undefined, toolAvailability: overview.status === "fulfilled" ? overview.value.toolAvailability : undefined });
        setLoadedIdentity(identity);
        // Poll promptly while OAuth is pending; otherwise focus/manual refresh
        // handles returns from settings and a slow check catches external edits.
        timer = setTimeout(() => void load(), connections?.pending?.length ? 5000 : 60_000);
      } finally {
        inFlight = false;
        if (!cancelled) setChecking(false);
      }
    };
    const onVisible = () => { void load(); };
    refresh.current = onVisible;
    void load();
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timer);
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [active, bot.id, identity]);

  const current = loadedIdentity === identity ? snapshot : undefined;
  const rows = botReadinessRows({
    instanceId: bot.modelSelection.instanceId,
    appsEnabled: bot.composio !== false,
    instances: current?.instances,
    connections: current?.connections,
    requirements: current?.requirements,
    toolAvailability: current?.toolAvailability,
  });
  return <section className="ui-surface" aria-label="setup status" aria-busy={checking}>
    <div className="flex items-center justify-between gap-3">
      <h3 className="ui-section-title">setup status</h3>
      <button type="button" disabled={checking} onClick={() => refresh.current()}
        className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-ink-secondary hover:bg-inset disabled:opacity-50">
        <RefreshCw size={12} aria-hidden="true" /> check again
      </button>
    </div>
    <p className="mt-1 text-[12px] text-ink-secondary">review the accounts this bot uses.</p>
    {checking || !current ? <p className="mt-3 text-[13px] text-ink-secondary" role="status">checking connections…</p> : <ul className="mt-3 divide-y divide-hairline/30">
      {rows.map(row => {
        const Icon = icons[row.state];
        return <li key={row.id} className="flex items-start gap-2.5 py-3" data-readiness-state={row.state}>
          <Icon size={15} aria-hidden="true" className={`mt-0.5 shrink-0 ${row.state === "ok" ? "text-success" : row.state === "action" ? "text-warning" : "text-ink-secondary"}`} />
          <div className="min-w-0 flex-1">
            <div className="break-words text-[13px] font-medium text-ink">{row.label}</div>
            <p className="mt-0.5 text-[12px] text-ink-secondary">{row.detail}</p>
            {row.action && <button type="button" onClick={() => onAction(row.action!)} className="mt-1.5 rounded text-left text-[12px] font-medium text-accent-text hover:underline">{row.actionLabel}</button>}
          </div>
        </li>;
      })}
    </ul>}
  </section>;
}
