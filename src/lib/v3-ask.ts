// 3.0: when a screen runs out of answers, hand the person to a bot. Opens
// that bot's chat (leaving Today) with a starter line in the composer, and
// never types over a draft the person already started.
import { COMPOSER_INSERT_EVENT, type ComposerInsertDetail } from "@/components/canvas/canvas";
import { setHomeOpen } from "@/lib/v3-home";
import type { Action } from "@/state/store";

export function askBot(dispatch: (action: Action) => void, bot: { id: string; threadId: string }, text: string): void {
  setHomeOpen(false);
  dispatch({ type: "select", id: bot.id });
  dispatch({ type: "showChat" });
  // one exact thread, and that composer keeps its own draft (ifEmpty)
  const detail: ComposerInsertDetail = { botId: bot.id, threadId: bot.threadId, text, ifEmpty: true };
  setTimeout(() => window.dispatchEvent(new CustomEvent(COMPOSER_INSERT_EVENT, { detail })), 120);
}
