import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Columns2, X } from "lucide-react";

import { ChatView } from "@/components/ChatView";
import { GroupView } from "@/components/GroupView";
import { TerminalPanel } from "@/components/TerminalPanel";
import { t } from "@/lib/i18n";
import { SPLIT_DRAG_TYPE, visibleSplitPanes } from "@/lib/split-view";
import { useSplitView } from "@/components/SplitViewContext";
import { cn } from "@/lib/cn";
import { useStore } from "@/state/store";

/** True while a sidebar bot or room row is being dragged. */
function useSplitDragActive(): boolean {
  const [active, setActive] = useState(false);
  useEffect(() => {
    const start = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes(SPLIT_DRAG_TYPE)) setActive(true);
    };
    const stop = () => setActive(false);
    window.addEventListener("dragstart", start);
    window.addEventListener("dragend", stop);
    window.addEventListener("drop", stop);
    return () => {
      window.removeEventListener("dragstart", start);
      window.removeEventListener("dragend", stop);
      window.removeEventListener("drop", stop);
    };
  }, []);
  return active;
}

/** The chat column: the primary conversation plus any split panes, and a
 * right-edge drop target while a sidebar row is dragged. */
export function SplitWorkspace({ children }: { children: ReactNode }) {
  const { state } = useStore();
  const { panes, openSplit, closeSplit, terminal, closeTerminal } = useSplitView();
  const dragging = useSplitDragActive();
  const [over, setOver] = useState(false);
  useEffect(() => { if (!dragging) setOver(false); }, [dragging]);
  const known = useMemo(() => new Set([...state.bots.filter((bot) => !bot.hidden).map((bot) => bot.id), ...state.groups.map((group) => group.id)]), [state.bots, state.groups]);
  const extras = visibleSplitPanes(panes, known, state.selectedId);

  return (
    <div className="relative flex h-full min-w-0 flex-1" data-testid="split-workspace">
      <div className="flex h-full min-w-0 flex-1">{children}</div>
      {extras.map((id) => {
        const group = state.groups.find((candidate) => candidate.id === id);
        const bot = group ? undefined : state.bots.find((candidate) => candidate.id === id);
        const name = group?.name ?? bot?.name ?? "";
        return (
          <section key={id} aria-label={t("split.pane", { name })} data-split-pane={id} className="relative flex h-full min-w-0 flex-1 border-l border-hairline/50 max-md:hidden">
            {group ? <GroupView key={group.id} group={group} /> : bot ? <ChatView key={bot.id} bot={bot} /> : null}
            {/* sits in the header's left gutter, level with the avatar */}
            <button type="button" onClick={() => closeSplit(id)} title={t("split.close")} aria-label={t("split.closeNamed", { name })}
              className="absolute left-1.5 top-[26px] z-20 flex size-5 items-center justify-center rounded text-ink-secondary hover:bg-raised hover:text-ink"><X size={12} /></button>
          </section>
        );
      })}
      {terminal && <TerminalPanel target={terminal} onClose={closeTerminal} />}
      {dragging && (
        <div
          data-testid="split-drop-zone"
          onDragOver={(event) => {
            if (!event.dataTransfer.types.includes(SPLIT_DRAG_TYPE)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(event) => {
            const id = event.dataTransfer.getData(SPLIT_DRAG_TYPE);
            if (!id) return;
            event.preventDefault();
            openSplit(id);
          }}
          className={cn(
            "absolute inset-y-2 right-2 z-30 flex w-[min(33%,320px)] items-center justify-center rounded-xl border-2 border-dashed text-[13px] transition-colors max-md:hidden",
            over ? "border-accent bg-accent/15 text-ink" : "border-hairline/70 bg-app/70 text-ink-secondary",
          )}
        >
          <span className="pointer-events-none flex items-center gap-2"><Columns2 size={16} />{t("split.drop")}</span>
        </div>
      )}
    </div>
  );
}
