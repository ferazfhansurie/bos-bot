import { parseContactId, type SharedRoom } from "../shared/multiplayer.ts";
import { sharedMentionText } from "../shared/shared-mentions.ts";
export { sharedMentionText } from "../shared/shared-mentions.ts";
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

/** Only explicit human mentions invoke bots. Code, quotes, links and bot output
 * are inert. Ambiguous names require the owner-qualified picker label. */
export function sharedRoomTargets<T extends { name: string; ownerName?: string }>(bots: T[], text: string, fromBot: boolean): T[] {
  if (fromBot) return [];
  const lower = sharedMentionText(text).toLocaleLowerCase();
  return bots.filter(bot => {
    const ambiguous = bots.filter(other => other.name.toLocaleLowerCase() === bot.name.toLocaleLowerCase()).length > 1;
    const aliases = bot.ownerName ? [`@${bot.name} · ${bot.ownerName}`, ...(!ambiguous ? [`@${bot.name}`] : [])] : ambiguous ? [] : [`@${bot.name}`];
    return aliases.some(alias => {
      const at = alias.toLocaleLowerCase();
      let index = lower.indexOf(at);
      while (index >= 0) {
        const before = index === 0 ? " " : lower[index - 1]!;
        const after = lower[index + at.length] ?? " ";
        if (!/[\p{L}\p{N}_@\\]/u.test(before) && !/[\p{L}\p{N}_-]/u.test(after)) return true;
        index = lower.indexOf(at, index + 1);
      }
      return false;
    });
  });
}

/** Existing direct access grants also apply to mentions, without bot membership. */
export function sharedRoomBotCandidates(room: SharedRoom, actorId: string | undefined, homeId: string, localBotIds: string[], linkedBotIds: string[]): string[] {
  const actor = parseContactId(actorId);
  const granted = actor?.kind === "person" && actor.localId === "owner"
    ? actor.homeId === homeId ? [...localBotIds, ...linkedBotIds]
      : linkedBotIds.filter(id => parseContactId(id)?.homeId === actor.homeId)
    : [];
  const legacy = room.memberIds.filter(id => {
    const bot = parseContactId(id);
    return bot?.kind === "bot" && (room.createdBy === `${bot.homeId}:person:owner` || (!room.createdBy && room.homeId === bot.homeId));
  });
  return [...new Set([...granted, ...legacy])];
}
