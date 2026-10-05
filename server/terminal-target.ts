import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import type { Store, BotRecord } from "./store.ts";
import { ensureTaskWorkspace } from "./workspace.ts";

/** Reading the folder must not pin or switch a conversation's provider cwd. */
export function resolveTerminalTarget(store: Store, botId: string, threadId: string, inheritedRemote: (bot: BotRecord) => boolean = () => false): string {
  const deny = (status: number, message: string): never => {throw Object.assign(new Error(message), {status});};
  let cwd: string;
  const bot = store.bot(botId);
  if (bot) {
    const task = store.taskByThread(botId,threadId);
    if (!task) return deny(404,"No such terminal thread");
    if (bot.sharedWorkComputer || inheritedRemote(bot) || ["vm","cloud","off"].includes(bot.computer ?? "") || ["vm","cloud"].includes(task.surface ?? "")) return deny(409,"Terminal requires a local host folder");
    cwd = task.cwd === null ? homedir() : task.cwd ?? (Object.keys(task.resumeCursors).length ? homedir() : bot.cwd ?? ensureTaskWorkspace(botId,threadId));
  } else {
    const room = store.group(botId);
    const task = room ? store.groupTaskByThread(botId,threadId) : null;
    if (!room || (!task && !(room.dm && room.threadId === threadId))) return deny(404,"No such terminal room thread");
    const pinned = task ? task.pinnedCwd : room.pinnedCwd;
    // Unpinned rooms have no common member cwd. Give the owner's terminal a
    // room/thread workspace instead of arbitrarily selecting a member's desk.
    cwd = (pinned === undefined ? room.cwd : pinned) ?? ensureTaskWorkspace(botId,threadId);
  }
  try {const real = realpathSync(cwd); if (!statSync(real).isDirectory()) return deny(409,"Terminal folder unavailable"); return real;}
  catch {return deny(409,"Terminal folder unavailable");}
}
