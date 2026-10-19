import { lazy, Suspense } from "react";
import { FileText } from "lucide-react";
import { registerTabKind } from "../workbench/registry";
import { useStore } from "@/state/store";
const PageEditor = lazy(() => import("./PageEditor").then(m => ({ default: m.PageEditor })));
import type { TabRenderProps } from "../workbench/registry";
function PageTab({ tab, target, setTab }: TabRenderProps) {
  const { state, dispatch } = useStore();
  if (state.groups.some(g => g.id === target.botId)) return <p className="p-5">Pages are private to direct conversations.</p>;
  return <Suspense fallback={<p className="p-5">Loading page…</p>}><PageEditor botId={target.botId} threadId={target.threadId} pageId={tab.ref}
    onPage={(ref, title) => setTab({ ref, title })}
    onAsk={(text, threadId) => dispatch({ type: "send", botId: target.botId, threadId, text })} /></Suspense>;
}
registerTabKind({ kind: "page", icon: FileText, title: tab => tab.title ?? "Untitled page", keepMounted: true, render: props => <PageTab {...props} /> });
