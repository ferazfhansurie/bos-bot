import { lazy, Suspense } from "react";
import { SquareDashed } from "lucide-react";
import { registerTabKind, type TabRenderProps } from "../workbench/registry";
import { useStore } from "@/state/store";
// the page renderer loads only when a blank tab opens
const CanvasTab = lazy(() => import("./CanvasTab").then(m => ({ default: m.CanvasTab })));

function CanvasKind({ tab, target, active, setTab, replace }: TabRenderProps) {
  const { state } = useStore();
  // in a room a blank tab opens the apps shared into it
  const room = state.groups.some(g => g.id === target.botId);
  return <Suspense fallback={<p className="p-5 text-[13px] text-ink-secondary">Loading…</p>}>
    <CanvasTab tab={tab} target={target} active={active} setTab={setTab} replace={replace} room={room} />
  </Suspense>;
}
registerTabKind({ kind: "canvas", icon: SquareDashed, title: tab => tab.title ?? "Blank tab", keepMounted: true, render: props => <CanvasKind {...props} /> });
