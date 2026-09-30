import { readFileSync } from "node:fs";
import { z } from "zod";

export const delegationScope = z.enum(["coordinate", "bots:create", "bots:delete", "bots:configure"]);
export type DelegationScope = z.infer<typeof delegationScope>;
export interface DelegatedIdentity { sessionId: string; tokenHash: string; homeId: string; botId: string }
const id = z.string().regex(/^[\w-]{1,128}$/);
const grantSchema = z.object({
  granteeHomeId: id, granteeBotId: id, peerSessionId: id, peerTokenHash: z.string().regex(/^[a-f0-9]{64}$/),
  scopes: z.array(delegationScope).min(1).max(4), section: z.string().max(60),
  note: z.string().max(500), expiresAt: z.number().finite().positive().optional(), autoApply: z.boolean().default(false),
}).strict();
export type CrossHomeGrant = z.infer<typeof grantSchema>;
const fileSchema = z.object({ version: z.literal(1), delegations: z.array(grantSchema).max(100) }).strict();
export class DelegationError extends Error { readonly status = 403; }

/** Read afresh at every authority boundary. Missing/malformed/revoked config
 * never retains a previously valid grant. Session binding comes from the
 * authenticated registry, never a caller-supplied session or home header. */
export class Delegations {
  private lastError = "";
  private readonly file: string;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  constructor(file: string, now = Date.now, log = (message: string) => console.warn(message)) { this.file = file; this.now = now; this.log = log; this.readEntries(); }
  private readEntries(): CrossHomeGrant[] {
    let entries: CrossHomeGrant[] = [];
    try {
      entries = fileSchema.parse(JSON.parse(readFileSync(this.file, "utf8"))).delegations;
      this.lastError = "";
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && !this.lastError) {
        this.lastError = "Delegation config is unreadable or malformed; access denied.";
        this.log(this.lastError);
      }
    }
    return entries;
  }
  require(identity: DelegatedIdentity, scope: DelegationScope): CrossHomeGrant {
    const matches = this.readEntries().filter(entry => entry.peerSessionId === identity.sessionId && entry.peerTokenHash === identity.tokenHash &&
      entry.granteeHomeId === identity.homeId && entry.granteeBotId === identity.botId &&
      (entry.expiresAt === undefined || entry.expiresAt > this.now()) && entry.scopes.includes(scope));
    if (matches.length !== 1) throw new DelegationError("No live delegation for this home, bot and scope");
    return matches[0];
  }
}
