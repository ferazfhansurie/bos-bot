// BOS 2.0 slice 5: the legacy writer freeze seam.
//
// When ship migrates this install into the cloud it writes one flag file,
// `<dataDir>/cloud-authority.json` = {workspace_id, epoch, state}. Once the
// state reaches `frozen` (and every later state up to `legacy_archived`) this
// local server must stop changing conversation state: room and message writes
// are refused with 409 {error:"authority_moved", workspace_id, epoch}, and no
// bot turn is dispatched. Reads stay allowed. A missing, unreadable or
// malformed flag, or any other state (inventoried, failed, held), is no freeze,
// so a rollback before cloud_active only has to delete the file.
//
// "That workspace" is this install. The legacy server is single-workspace:
// one data dir is one home. The flag lives inside that data dir, so its
// location already scopes it; the cloud workspace_id it names is minted by the
// cloud and has no local counterpart to compare with (the local environment-id
// is a federation home id, not a cloud workspace id). Requiring equality would
// make a mismatch fail open mid-migration, so any valid frozen flag freezes the
// whole install and its workspace_id/epoch are echoed in the refusal.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const CLOUD_AUTHORITY_FILE = "cloud-authority.json";

export const CLOUD_AUTHORITY_STATES = [
  "inventoried", "frozen", "imported", "validated", "cloud_active", "legacy_archived", "failed", "held",
] as const;
export type CloudAuthorityState = typeof CLOUD_AUTHORITY_STATES[number];

/** States in which the cloud, not this install, owns conversation writes. */
export const FROZEN_AUTHORITY_STATES: ReadonlySet<CloudAuthorityState> =
  new Set(["frozen", "imported", "validated", "cloud_active", "legacy_archived"]);

export interface CloudAuthorityFlag {
  workspace_id: string;
  /** Echoed exactly as written: a non-negative integer, or its decimal string. */
  epoch: number | string;
  state: CloudAuthorityState;
}

export interface AuthorityMovedBody { error: "authority_moved"; workspace_id: string; epoch: number | string }

/** Shape-check a parsed flag. Anything unexpected is null: no freeze. */
export function parseCloudAuthorityFlag(value: unknown): CloudAuthorityFlag | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { workspace_id, epoch, state } = value as Record<string, unknown>;
  if (typeof workspace_id !== "string" || !workspace_id.trim() || workspace_id.length > 256) return null;
  const epochOk = typeof epoch === "number"
    ? Number.isSafeInteger(epoch) && epoch >= 0
    : typeof epoch === "string" && /^(0|[1-9]\d{0,63})$/.test(epoch);
  if (!epochOk) return null;
  if (typeof state !== "string" || !(CLOUD_AUTHORITY_STATES as readonly string[]).includes(state)) return null;
  return { workspace_id, epoch: epoch as number | string, state: state as CloudAuthorityState };
}

export function isFrozenAuthority(flag: CloudAuthorityFlag | null): flag is CloudAuthorityFlag {
  return Boolean(flag && FROZEN_AUTHORITY_STATES.has(flag.state));
}

export function authorityMovedBody(flag: CloudAuthorityFlag): AuthorityMovedBody {
  return { error: "authority_moved", workspace_id: flag.workspace_id, epoch: flag.epoch };
}

/** The error a dispatch chokepoint throws; the HTTP layer renders it as the
 * exact 409 body, background callers treat it like any refused dispatch. */
export function authorityMovedError(flag: CloudAuthorityFlag): Error & { status: 409; code: "authority_moved"; body: AuthorityMovedBody } {
  return Object.assign(new Error("authority_moved"), { status: 409 as const, code: "authority_moved" as const, body: authorityMovedBody(flag) });
}

/** Reads the flag freshly, re-parsing only when the file's identity or mtime
 * changes, so ship's freeze (and a rollback deleting the file) takes effect on
 * the next request without a restart. */
export class CloudAuthority {
  readonly file: string;
  #key: string | null = null;
  #flag: CloudAuthorityFlag | null = null;
  #announced: string | null = null;
  readonly #log: (line: string) => void;

  constructor(dataDir: string, log: (line: string) => void = (line) => console.warn(line)) {
    this.file = join(dataDir, CLOUD_AUTHORITY_FILE);
    this.#log = log;
  }

  current(): CloudAuthorityFlag | null {
    let key: string;
    try {
      const stat = statSync(this.file);
      if (!stat.isFile()) return this.#remember(null, null);
      key = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    } catch {
      return this.#remember(null, null);
    }
    if (key === this.#key) return this.#flag;
    let flag: CloudAuthorityFlag | null = null;
    try { flag = parseCloudAuthorityFlag(JSON.parse(readFileSync(this.file, "utf8"))); } catch { flag = null; }
    return this.#remember(key, flag);
  }

  /** The freeze in force, or null when this install still owns its writes. */
  frozen(): CloudAuthorityFlag | null {
    const flag = this.current();
    return isFrozenAuthority(flag) ? flag : null;
  }

  /** Throws the 409 authority_moved error when frozen. `what` names the
   * refused dispatch for the once-per-freeze log line. */
  assertWritable(what = "bot dispatch"): void {
    const flag = this.frozen();
    if (!flag) return;
    const announced = `${flag.workspace_id}\u0000${String(flag.epoch)}\u0000${flag.state}`;
    if (this.#announced !== announced) {
      this.#announced = announced;
      this.#log(`cloud authority: workspace ${flag.workspace_id} epoch ${String(flag.epoch)} is ${flag.state}; refusing ${what} and further local writes`);
    }
    throw authorityMovedError(flag);
  }

  #remember(key: string | null, flag: CloudAuthorityFlag | null): CloudAuthorityFlag | null {
    this.#key = key;
    this.#flag = flag;
    if (!isFrozenAuthority(flag)) this.#announced = null;
    return flag;
  }
}

const ROOM_OR_MESSAGE_WRITE: readonly RegExp[] = [
  // Local rooms (groups) and every route under them, including the linked
  // rooms remote-rooms.ts relays to another home under these same paths.
  /^\/api\/groups(?:\/|$)/,
  // Room creation by importing a team package.
  /^\/api\/teams\/import$/,
  // Thread transcripts: messages, reactions, approval answers, images.
  /^\/api\/threads\/[\w-]+\//,
  // Direct-chat writes and the turns they start.
  /^\/api\/bots\/[\w-]+\/(?:messages|queue|compact|active-branch|respond|tasks|threads|cards|secret-cards|connector-cards|history\/rollback)(?:\/|$)/,
  // Deleting a bot deletes its conversations.
  /^\/api\/bots\/[\w-]+$/,
  // Shared (multiplayer) rooms, DMs and peer threads on linked homes.
  /^\/api\/multiplayer\/(?:rooms|dm|peer-threads)(?:\/|$)/,
  // Bot coordination tools: they post into rooms and start other bots.
  /^\/api\/internal\/(?:post-to-room|delegate-bot|ask-bot|coordinate-bots|threads|retry-thread|create-room|manage-room)(?:\/|$)/,
  /^\/api\/delegated\/coordinate(?:\/|$)/,
  // Manual and test triggers that dispatch a bot run or open a room.
  /^\/api\/routines\/[\w-]+\/run$/,
  /^\/api\/webhooks\/[\w-]+\/test$/,
  /^\/api\/calendar-calls\/[\w-]+\/room$/,
];

/** Routes that only stop work or record what one viewer has seen. */
const ALWAYS_ALLOWED: readonly RegExp[] = [
  /^\/api\/(?:groups|bots)\/[\w-]+\/(?:read|interrupt)$/,
  /^\/api\/multiplayer\/rooms\/[\w-]+\/preferences$/,
];

/** True for a request the freeze must refuse: a mutating method on a room,
 * message, thread or bot-dispatch route. Reads are never guarded. */
export function isAuthorityGuardedRequest(method: string, path: string): boolean {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return false;
  if (path === "/api/bots") return false; // bot creation is configuration, not conversation
  if (ALWAYS_ALLOWED.some((pattern) => pattern.test(path))) return false;
  if (/^\/api\/bots\/[\w-]+$/.test(path)) return method === "DELETE";
  return ROOM_OR_MESSAGE_WRITE.some((pattern) => pattern.test(path));
}
