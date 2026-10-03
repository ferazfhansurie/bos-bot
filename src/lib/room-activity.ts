import type { Message } from "@/state/store";

/** Whether a room shows this activity chip. With tool calls hidden (the
 * default) failures hide too — a red failed-command row was the loudest
 * thing in a room, and the thinking line already names the live step. A
 * bot⇄bot comm chip still shows: "Messaged
 * @Ada" is the only trace, where the person is reading, that a teammate
 * was consulted — the 1:1 chat has kept that exemption all along, and a
 * room that dropped it made a silent-by-default exchange an invisible one.
 * An opened-thread chip is the same kind of trace: the only sign, here,
 * that a bot started a thread the person may want to look at. */
export function roomActivityVisible(message: Message, showToolCalls: boolean): boolean {
  const tool = message.tool;
  if (message.kind !== "activity" || !tool) return false;
  if (message.comm || message.threadRef) return true;
  return showToolCalls;
}
