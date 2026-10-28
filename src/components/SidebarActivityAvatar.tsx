// The sidebar's bot face moves with the feed: whatever any of the bot's
// threads is doing, while the person reads another chat. Resting bots keep
// the still BotAvatar, so N idle rows cost nothing.
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Bot } from "@/state/store";
import {
  activityFeed, botActivityState, isActiveActivity, useActivityFeed,
  type ActivityFeed, type ActivityState,
} from "@/lib/activity-feed";
import { derivePresence, gestureForPresence } from "../../shared/mascot-presence";
import { GESTURE_TIMING, type MascotGesture } from "../../shared/mascot-choreography";
import { ActivityMascot } from "./ActivityMascot";

export function useBotActivity(bot: Pick<Bot, "id" | "threadId" | "activity" | "busy" | "tasks">, feed: ActivityFeed = activityFeed): { state: ActivityState; gesture: MascotGesture; finishing: boolean } {
  useActivityFeed(feed);
  const tasks = bot.tasks ?? [{ threadId: bot.threadId, activity: bot.activity, busy: bot.busy }];
  const state = botActivityState(feed.forBot(bot.id), tasks);
  const active = isActiveActivity(state);
  const wasActive = useRef(active);
  const [finishing, setFinishing] = useState(false);
  useEffect(() => {
    // one settle hop when work ends cleanly; a failure or stop just rests
    const settled = wasActive.current && !active && state === "idle";
    wasActive.current = active;
    if (!settled) { setFinishing(false); return; }
    setFinishing(true);
    const timer = setTimeout(() => setFinishing(false), GESTURE_TIMING.finished[0]);
    return () => clearTimeout(timer);
  }, [active, state]);
  return { state, finishing, gesture: gestureForPresence(derivePresence({ surface: "sidebar", feed: state, finishing })) };
}

export function SidebarActivityAvatar({ bot, gesture, size, children }: {
  bot: Bot;
  gesture: MascotGesture;
  size: number;
  /** the resting avatar, shown whenever nothing is happening */
  children?: ReactNode;
}) {
  if (gesture === "idle") return <>{children}</>;
  return <span data-sidebar-activity-mascot={gesture} className="flex">
    <ActivityMascot bot={bot} gesture={gesture} size={size} />
  </span>;
}
