import { lazy, Suspense } from "react";
import { Clapperboard } from "lucide-react";
import { registerTabKind, type TabRenderProps } from "../workbench/registry";
import { useStore } from "@/state/store";
// the editor (timeline, preview, playback) loads only when a video tab opens
const VideoEditor = lazy(() => import("./VideoEditor").then(m => ({ default: m.VideoEditor })));

function VideoTab({ tab, target, active, setTab, replace }: TabRenderProps) {
  const { state, dispatch } = useStore();
  if (state.groups.some(g => g.id === target.botId)) return <p className="p-5 text-[13px] text-ink-secondary">Videos are private to direct conversations.</p>;
  return <Suspense fallback={<p className="p-5 text-[13px] text-ink-secondary">Loading video…</p>}>
    <VideoEditor botId={target.botId} threadId={target.threadId} videoId={tab.ref} active={active}
      onVideo={(ref, title) => setTab({ ref, title })}
      // setTab cannot clear a ref, so going back to the list swaps in a fresh video tab
      onList={() => replace("video")}
      onAsk={(text, threadId) => dispatch({ type: "send", botId: target.botId, threadId, text })} />
  </Suspense>;
}
registerTabKind({ kind: "video", icon: Clapperboard, title: tab => tab.title ?? "New video", keepMounted: true, render: props => <VideoTab {...props} /> });
