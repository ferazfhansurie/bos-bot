// The app badge (dock, taskbar): conversations with something unread that
// the person still wants interrupting about. A muted room or a muted bot
// keeps its sidebar dot but stays off the badge, the way a muted chat does
// in any messaging app.
import type { Bot, Group } from "@/state/store";

export function unreadBadgeCount(
  bots: ReadonlyArray<Pick<Bot, "hidden" | "unread" | "notifications">>,
  groups: ReadonlyArray<Pick<Group, "unread" | "notifications">>,
): number {
  return bots.filter((bot) => !bot.hidden && bot.unread && bot.notifications !== false).length +
    groups.filter((group) => group.unread && group.notifications !== "muted").length;
}
