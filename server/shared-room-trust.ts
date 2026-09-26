import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomic } from "./atomic.ts";

/** How much a shared room may make this home's bots do. Set by the owner of
 * this Mac only; a room member can never raise it.
 * - helper: a sandbox folder for the room, the engine's own auto review, and
 *   no private memory, projects, accounts, messages or money.
 * - trusted: the bot's own approval level and folder, as in its own chats. */
export type SharedRoomTrustLevel = "helper" | "trusted";

export function isSharedRoomTrustLevel(value: unknown): value is SharedRoomTrustLevel {
  return value === "helper" || value === "trusted";
}

export class SharedRoomTrust {
  private readonly levels = new Map<string, SharedRoomTrustLevel>();
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
    if (!existsSync(file)) return;
    try {
      const saved = JSON.parse(readFileSync(file, "utf8")) as unknown;
      if (saved && typeof saved === "object" && !Array.isArray(saved)) {
        for (const [roomId, level] of Object.entries(saved)) {
          if (/^[\w-]{1,128}$/.test(roomId) && isSharedRoomTrustLevel(level)) this.levels.set(roomId, level);
        }
      }
    } catch { /* unreadable: every room falls back to its default level */ }
  }

  get(roomId: string): SharedRoomTrustLevel | undefined { return this.levels.get(roomId); }

  set(roomId: string, level: SharedRoomTrustLevel): void {
    if (!/^[\w-]{1,128}$/.test(roomId)) throw new Error("invalid room id");
    this.levels.set(roomId, level);
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.file, JSON.stringify(Object.fromEntries(this.levels)), { mode: 0o600 });
  }
}

/** Which bots a message is addressed to: every @named bot, @everyone for
 * all of them, else the room's lead bot for a person's message. */
export function sharedRoomTargets<T extends { name: string }>(bots: T[], text: string, fromBot: boolean): T[] {
  const lower = text.toLowerCase();
  if (/(^|[^\w@])@(everyone|all|bots)\b/.test(lower)) return bots;
  const named = bots.filter(bot => {
    const at = `@${bot.name.toLowerCase()}`;
    let index = lower.indexOf(at);
    while (index >= 0) {
      const before = index === 0 ? " " : lower[index - 1]!;
      const after = lower[index + at.length] ?? " ";
      if (!/[\w@]/.test(before) && !/\w/.test(after)) return true;
      index = lower.indexOf(at, index + 1);
    }
    return false;
  });
  if (named.length || fromBot) return named;
  return bots.slice(0, 1);
}
