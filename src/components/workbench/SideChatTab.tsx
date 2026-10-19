/** A side chat: a second thread of the same bot, shown in a tab beside the
 * main conversation. It is a real task thread (created with activate:false
 * so the conversation on screen stays put), so the bot works in it exactly
 * as it would anywhere else. */
import { useEffect } from "react";

import { ChatView } from "@/components/ChatView";
import { botForThread, useStore } from "@/state/store";

export function SideChatTab({ botId, threadId }: { botId: string; threadId: string }) {
  const { state, dispatch } = useStore();
  const bot = state.bots.find((candidate) => candidate.id === botId);
  const pane = state.threadPanes[threadId];
  const live = bot?.threadId === threadId;
  const known = Boolean(bot?.tasks?.some((task) => task.threadId === threadId)) || live;
  useEffect(() => {
    if (bot && known && !live && !pane) dispatch({ type: "threadPaneOpen", botId: bot.id, threadId });
  }, [bot, known, live, pane, threadId, dispatch]);
  if (!bot || !known) {
    return <p className="p-5 text-[13px] text-ink/50">This side chat is no longer available.</p>;
  }
  // the tab strip already names it; the chat's own header would repeat the bot
  return (
    <div className="workbench-sidechat [&_.conversation-header]:hidden flex min-h-0 flex-1 flex-col" data-testid="workspace-sidechat">
      <ChatView key={threadId} bot={botForThread(bot, threadId, pane)} />
    </div>
  );
}
