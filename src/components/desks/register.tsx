import { lazy, Suspense } from "react";
import { AppWindow } from "lucide-react";
import { registerTabKind, type TabRenderProps } from "../workbench/registry";
import { useStore } from "@/state/store";
// the openui renderer loads only when a desk opens
const DeskTab = lazy(() => import("./DeskTab").then(m => ({ default: m.DeskTab })));

function DeskKind({ tab, target, active, setTab }: TabRenderProps) {
  const { state } = useStore();
  if (state.groups.some(g => g.id === target.botId)) return <p className="p-5 text-[13px] text-ink-secondary">Desks belong to direct conversations.</p>;
  if (!tab.ref) return <p className="p-5 text-[13px] text-ink-secondary">Ask bos to open an app here, e.g. "open meta ads manager as a desk".</p>;
  return <Suspense fallback={<p className="p-5 text-[13px] text-ink-secondary">Loading…</p>}>
    <DeskTab tab={tab} target={target} active={active} setTab={setTab} />
  </Suspense>;
}
registerTabKind({ kind: "desk", icon: AppWindow, title: tab => tab.title ?? "Desk", render: props => <DeskKind {...props} /> });
