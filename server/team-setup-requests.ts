import { createHash } from "node:crypto";
import { z } from "zod";
import { newId, type ModelSelection } from "./contracts.ts";
import { fitsOnOneLine, parseBotProfilePatch } from "./bot-profile.ts";
import { profileSnapshot } from "./profile-revision.ts";
import { redactSecretsInText } from "./redact.ts";
import type { BotRecord, OptionCardData } from "./store.ts";
import type { TeamSetupFields, TeamSetupOperation, TeamSetupRequest, TeamSetupResult } from "../shared/team-setup.ts";

const section = (value?: string) => value?.trim() || "";
const teamName = z.string().trim().min(1).max(60).refine(fitsOnOneLine).refine((value) => redactSecretsInText(value) === value, "Team names cannot contain credentials");
const fieldsSchema = z.object({
  name: z.string().optional(), title: z.string().optional(), description: z.string().optional(), soul: z.string().optional(),
  section: z.string().trim().max(60).refine(fitsOnOneLine).refine((value) => redactSecretsInText(value) === value, "Team names cannot contain credentials").optional(),
  modelSelection: z.object({ instanceId: z.string().trim().min(1), model: z.string().trim().min(1), effort: z.string().optional() }).strict().optional(),
}).strict();
const planSchema = z.object({
  reason: z.string().trim().min(1).max(500),
  newTeams: z.array(teamName).max(8).default([]),
  operations: z.array(z.discriminatedUnion("action", [
    z.object({ action: z.literal("create"), key: z.string().trim().min(1).max(80), fields: fieldsSchema }).strict(),
    z.object({ action: z.literal("update"), botId: z.string().min(1).max(128), fields: fieldsSchema }).strict(),
  ])).min(1).max(24),
}).strict();

export class TeamSetupError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

/** Settings relevant to approval, including the previous durable receipt. */
export function teamSetupRevision(bot: BotRecord): string {
  return createHash("sha256").update(JSON.stringify({
    ...profileSnapshot(bot), section: section(bot.section), modelSelection: bot.modelSelection,
    hidden: Boolean(bot.hidden), chiefOfStaff: Boolean(bot.chiefOfStaff), peers: bot.peers,
    managedSections: bot.managedSections,
    approvalMode: bot.approvalMode, autoApprove: bot.autoApprove, approvalGrant: bot.approvalGrant,
    receipt: bot.lastTeamSetupReceipt?.requestId,
  })).digest("hex");
}

interface SetupStore {
  bots: BotRecord[];
  bot(id: string): BotRecord | null | undefined;
  messagesFor(threadId: string): Array<{ id: string; card?: OptionCardData }>;
  appendMessage(threadId: string, message: { role: "bot"; kind: "options"; card: OptionCardData; from?: { botId: string; name: string; color: string } }): { id: string };
  patchMessage(threadId: string, messageId: string, patch: { card: OptionCardData }): unknown;
  applyTeamSetup(request: TeamSetupRequest): TeamSetupResult;
}

export interface TeamSetupOptions {
  applyRemote?(request: TeamSetupRequest): Promise<TeamSetupResult>;
  requester?(botId: string): BotRecord | undefined;
  guard?(request: TeamSetupRequest): void;
  delegation?: TeamSetupRequest["delegation"];
  store: SetupStore;
  teams(): string[];
  canAccessTeam(from: BotRecord, target?: string): boolean;
  canPersist(botId: string, threadId: string): { ok: true } | { ok: false; status: number; error: string };
  validateModel(selection: ModelSelection, current?: BotRecord): string | null;
  targetBusy(botId: string, sourceThreadId?: string): boolean;
  /** The caller resolves the effective mode of this exact conversation. */
  autoApply?(botId: string, threadId: string, request?: TeamSetupRequest): boolean;
  validateChange?(before: BotRecord, fields: TeamSetupFields): void;
  maxBots: number;
  ownsThread(botId: string, threadId: string): boolean;
  deleteBot(botId: string, revalidate: () => void, request: TeamSetupRequest): Promise<void>;
}

type RequestFrom = { botId: string; name: string; color: string };
type SetupArgs = { botId: string; threadId: string; plan: unknown; home?: string; from?: RequestFrom };
type DeletionArgs = { botId: string; threadId: string; targetBotId: string; reason: string; home?: string; from?: RequestFrom };
/** Server-only invocation lease. Never saved on a request or approval card. */
type SubmitAuthority = { canCommit?: () => boolean };

export class TeamSetupRequestService {
  private readonly resolving = new Set<string>();
  private readonly options: TeamSetupOptions;
  constructor(options: TeamSetupOptions) { this.options = options; }

  private chief(botId: string): BotRecord {
    const chief = this.options.requester ? this.options.requester(botId) : this.options.store.bot(botId);
    if (!chief || chief.hidden || !chief.chiefOfStaff) throw new TeamSetupError("Only an active Chief of Staff can propose team setup", 403);
    return chief;
  }

  private fields(input: z.infer<typeof fieldsSchema>, current?: BotRecord): TeamSetupFields {
    const { section: targetSection, modelSelection, ...profile } = input;
    const safe = Object.fromEntries(Object.entries(profile).map(([key, value]) => [key, redactSecretsInText(value!)]));
    const parsed = parseBotProfilePatch(safe, true);
    if (!parsed.ok) throw new TeamSetupError(parsed.error);
    const result: TeamSetupFields = { ...parsed.patch };
    if (targetSection !== undefined) result.section = targetSection;
    if (modelSelection) {
      const selection = modelSelection as ModelSelection;
      const error = this.options.validateModel(selection, current);
      if (error) throw new TeamSetupError(error);
      result.modelSelection = selection;
    }
    return result;
  }

  private autoApply(request: TeamSetupRequest) {
    return this.options.delegation ? this.options.autoApply?.(request.botId, request.threadId, request)
      : this.options.autoApply?.(request.botId, request.threadId);
  }

  private validate(request: TeamSetupRequest, confirming: boolean, immediate = false): void {
    this.options.guard?.(request);
    const chief = this.chief(request.botId);
    if (!this.options.ownsThread(request.botId, request.threadId)) throw new TeamSetupError("The requesting conversation no longer exists", 409);
    if (immediate && !this.autoApply(request)) throw new TeamSetupError(request.delegation ? "Scoped delegation auto-apply is no longer enabled" : "Full Access is no longer enabled for this conversation", 409);
    if (confirming && !immediate && !this.options.store.messagesFor(request.threadId).some((message) => message.card?.requestId === request.requestId && !message.card.answered && !message.card.dismissed)) throw new TeamSetupError("This setup card is no longer pending", 409);
    if (confirming && teamSetupRevision(chief) !== request.requesterRevision) throw new TeamSetupError("The Chief's settings changed. This setup was cancelled; review a new proposal.", 409);
    if (request.remote) {
      if (!this.options.applyRemote || !/^[\w-]{1,128}$/.test(request.remote.home)) throw new TeamSetupError("Remote setup is unavailable", 403);
      return; // The target home revalidates catalog, scope, revisions and running work.
    }
    const existingTeams = new Set(this.options.teams().map(section));
    if (new Set([...(chief.managedSections ?? []), ...request.newTeams]).size > 100) throw new TeamSetupError("A Chief may coordinate at most 100 additional teams", 409);
    for (const name of request.newTeams) if (existingTeams.has(name)) throw new TeamSetupError(`Team ${JSON.stringify(name)} now exists. Review a new proposal.`, 409);
    const allowed = (name?: string) => request.newTeams.includes(section(name)) || this.options.canAccessTeam(chief, name);
    const targets = new Set<string>();
    const projected = this.options.store.bots.map((bot) => ({ id: bot.id, name: bot.name, section: section(bot.section), chiefOfStaff: bot.chiefOfStaff, hidden: bot.hidden }));
    for (const operation of request.operations) {
      if (targets.has(operation.botId)) throw new TeamSetupError("A bot appears twice in the prepared setup");
      targets.add(operation.botId);
      const target = this.options.store.bot(operation.botId);
      if (operation.action === "create") {
        if (target) throw new TeamSetupError("A proposed bot already exists. Review a new proposal.", 409);
        if (!operation.fields.name?.trim() || !operation.fields.title?.trim() || !operation.fields.soul?.trim() || !operation.fields.modelSelection) throw new TeamSetupError("Each new bot needs a name, title, soul instructions, and exact model selection");
      } else {
        if (!target || target.hidden || !this.options.canAccessTeam(chief, target.section) || (target.id !== chief.id && Array.isArray(chief.peers) && !chief.peers.includes(target.id))) throw new TeamSetupError("A target bot is outside this Chief's authorized team and peer scope", 403);
        if (teamSetupRevision(target) !== operation.expectedRevision) throw new TeamSetupError(`@${target.name} changed. This setup was cancelled; review a new proposal.`, 409);
        const sourceThreadId = immediate && target.id === chief.id ? request.threadId : undefined;
        if (this.options.targetBusy(target.id, sourceThreadId) && (confirming || target.id !== chief.id)) throw new TeamSetupError(`Stop @${target.name}'s work before changing its setup`, 409);
      }
      const fields = this.fields(operation.fields, target ?? undefined);
      if (confirming && target) this.options.validateChange?.(target, fields);
      const destination = fields.section ?? target?.section ?? chief.section;
      if (!allowed(destination)) throw new TeamSetupError("The destination team is outside this Chief's authorized scope", 403);
      if (!request.newTeams.includes(section(destination)) && !existingTeams.has(section(destination))) throw new TeamSetupError("The destination team no longer exists", 409);
      const next = { id: operation.botId, name: fields.name ?? target!.name, section: section(destination), chiefOfStaff: target?.chiefOfStaff, hidden: false };
      const at = projected.findIndex((bot) => bot.id === operation.botId);
      if (at < 0) projected.push(next); else projected[at] = next;
    }
    if (this.options.store.bots.length + request.operations.filter((op) => op.action === "create").length > this.options.maxBots) throw new TeamSetupError("This setup exceeds the workspace bot limit", 409);
    for (const name of request.newTeams) if (!request.operations.some((op) => section(op.fields.section) === name)) throw new TeamSetupError(`New team ${JSON.stringify(name)} needs a specialist in this setup`);
    for (const operation of request.operations) {
      const candidate = projected.find((bot) => bot.id === operation.botId)!;
      if (projected.some((bot) => bot.id !== candidate.id && !bot.hidden && bot.section === candidate.section && bot.name.trim().toLowerCase() === candidate.name.trim().toLowerCase())) throw new TeamSetupError(`@${candidate.name} already exists in that team`, 409);
      if (candidate.chiefOfStaff && projected.some((bot) => bot.id !== candidate.id && bot.chiefOfStaff && bot.section === candidate.section)) throw new TeamSetupError("That move would put two Chiefs in one team", 409);
    }
    if (request.deletion) {
      const target = this.options.store.bot(request.deletion.botId);
      if (!target || target.hidden || target.id === chief.id || !this.options.canAccessTeam(chief, target.section) || (Array.isArray(chief.peers) && !chief.peers.includes(target.id))) throw new TeamSetupError("This deletion target is no longer an authorized teammate", 403);
      if (teamSetupRevision(target) !== request.deletion.expectedRevision || this.options.targetBusy(target.id)) throw new TeamSetupError("The deletion target changed or is working. Review a new deletion proposal.", 409);
    }
  }

  private prepare(args: SetupArgs) {
    const parsed = planSchema.safeParse(args.plan);
    if (!parsed.success) throw new TeamSetupError(parsed.error.issues[0]?.message ?? "Invalid team setup");
    const chief = this.chief(args.botId);
    if (args.home) {
      // Validate profiles locally, but provider/account and target scope belong to the remote catalog.
      const plan = parsed.data;
      for (const op of plan.operations) {
        const { modelSelection: _model, section: _section, ...profile } = op.fields;
        const checked = parseBotProfilePatch(Object.fromEntries(Object.entries(profile).map(([k, v]) => [k, redactSecretsInText(v!)])), true);
        if (!checked.ok) throw new TeamSetupError(checked.error);
        Object.assign(op.fields, checked.patch);
        if (op.action === "create" && (!op.fields.name?.trim() || !op.fields.title?.trim() || !op.fields.soul?.trim() || !op.fields.modelSelection)) throw new TeamSetupError("Each new bot needs a name, title, soul instructions, and exact model selection");
      }
      const request: TeamSetupRequest = { version: 1, requestId: newId(), botId: args.botId, threadId: args.threadId,
        reason: redactSecretsInText(plan.reason), createdAt: Date.now(), requesterRevision: teamSetupRevision(chief),
        newTeams: plan.newTeams, operations: plan.operations.map(op => ({ action: op.action, botId: op.action === "create" ? op.key : op.botId, fields: op.fields as TeamSetupFields })),
        remote: { home: args.home, plan: { ...plan, reason: redactSecretsInText(plan.reason) } } };
      this.validate(request, false); return request;
    }
    const combined = new Map<string, typeof parsed.data.operations[number]>();
    for (const operation of parsed.data.operations) {
      const key = operation.action === "create" ? `create:${operation.key}` : `update:${operation.botId}`;
      const previous = combined.get(key);
      combined.set(key, { ...operation, fields: { ...previous?.fields, ...operation.fields } });
    }
    if (combined.size > 8) throw new TeamSetupError("Review at most eight bots in one setup");
    const operations: TeamSetupOperation[] = [...combined.values()].map((operation) => {
      const target = operation.action === "update" ? this.options.store.bot(operation.botId) : undefined;
      return { action: operation.action, botId: operation.action === "create" ? newId() : operation.botId,
        ...(operation.action === "create" ? { threadId: newId() } : {}),
        fields: this.fields({ ...operation.fields, section: operation.fields.section ?? target?.section ?? chief.section ?? "" }, target ?? undefined),
        ...(target ? { expectedRevision: teamSetupRevision(target) } : {}),
      };
    });
    const request: TeamSetupRequest = { version: 1, requestId: newId(), botId: args.botId, threadId: args.threadId,
      reason: redactSecretsInText(parsed.data.reason), createdAt: Date.now(), requesterRevision: teamSetupRevision(chief),
      newTeams: [...new Set(parsed.data.newTeams)], operations };
    if (this.options.delegation) request.delegation = this.options.delegation;
    this.validate(request, false);
    return request;
  }

  private prepareDeletion(args: DeletionArgs) {
    const chief = this.chief(args.botId);
    if (args.home) {
      if (!/^[\w-]{1,128}$/.test(args.targetBotId) || !args.reason.trim() || args.reason.length > 500) throw new TeamSetupError("An exact remote bot id and deletion reason are required");
      const request: TeamSetupRequest = { version: 1, requestId: newId(), botId: args.botId, threadId: args.threadId,
        reason: redactSecretsInText(args.reason), createdAt: Date.now(), requesterRevision: teamSetupRevision(chief), newTeams: [], operations: [],
        remote: { home: args.home }, deletion: { botId: args.targetBotId, name: args.targetBotId, expectedRevision: "" } };
      this.validate(request, false); return request;
    }
    const target = this.options.store.bot(args.targetBotId);
    if (!target) throw new TeamSetupError("That bot no longer exists", 404);
    if (!args.reason.trim() || args.reason.length > 500) throw new TeamSetupError("A deletion reason of at most 500 characters is required");
    const request: TeamSetupRequest = { version: 1, requestId: newId(), botId: args.botId, threadId: args.threadId,
      reason: redactSecretsInText(args.reason), createdAt: Date.now(), requesterRevision: teamSetupRevision(chief), newTeams: [], operations: [],
      deletion: { botId: target.id, name: target.name, expectedRevision: teamSetupRevision(target) } };
    if (this.options.delegation) request.delegation = this.options.delegation;
    this.validate(request, false);
    return request;
  }

  propose(args: SetupArgs) { return this.card(this.prepare(args), args.from); }
  proposeDeletion(args: DeletionArgs) { return this.card(this.prepareDeletion(args), args.from); }

  async submit(args: SetupArgs & SubmitAuthority) {
    const request = this.prepare(args);
    if (this.autoApply(request)) return this.applyImmediately(request, args.from, args.canCommit);
    return { ...this.card(request, args.from), applied: false, state: "pending" as const };
  }

  async submitDeletion(args: DeletionArgs & SubmitAuthority) {
    const request = this.prepareDeletion(args);
    if (this.autoApply(request)) return this.applyImmediately(request, args.from, args.canCommit);
    return { ...this.card(request, args.from), applied: false, state: "pending" as const };
  }

  private cardData(request: TeamSetupRequest, immediate = false): OptionCardData {
    const permission = this.options.canPersist(request.botId, request.threadId);
    if (!permission.ok) throw new TeamSetupError(permission.error, permission.status);
    const chief = this.chief(request.botId);
    const lines = [`Why: ${request.reason}`];
    if (request.remote) lines.push(`Target home: ${request.remote.home}. This decision authorizes one scoped remote request; an uncertain outcome is never replayed.`);
    if (request.delegation) lines.push(`Delegated request from home ${request.delegation.homeId}, Chief ${request.delegation.botId}. Approval does not grant Full Access or change account permissions.`);
    if (request.deletion) lines.push(`Delete @${request.deletion.name} (${request.deletion.botId}).`, "Permanently removes this bot, all its conversations, memory, instructions, skills, and any computer owned only by it. Generated project files and shared team computers remain. Active work or an unavailable provider can block deletion safely.");
    if (request.newTeams.length) lines.push(`Create teams: ${request.newTeams.map((name) => JSON.stringify(name)).join(", ")}.`, `Authorize @${chief.name} to coordinate and propose setup changes in these new teams.`);
    for (const operation of request.operations) {
      const current = request.remote ? undefined : this.options.store.bot(operation.botId);
      lines.push(`\n${operation.action === "create" ? "Create" : "Update"} @${operation.fields.name ?? current?.name ?? operation.botId} (${operation.action === "create" ? "new bot" : operation.botId})`);
      for (const [key, value] of Object.entries(operation.fields)) {
        const before = current ? (key === "section" ? current.section || "General" : current[key as keyof BotRecord]) : undefined;
        lines.push(`${key === "modelSelection" ? "Default engine/model" : key}: ${current ? `${JSON.stringify(before ?? "")} → ` : ""}${key === "section" ? JSON.stringify(value || "General") : JSON.stringify(value)}`);
      }
    }
    if (!request.deletion) lines.push("\nDefault models apply to groups and new threads. Every existing thread keeps its current model and permissions.", "New bots start in Ask with connected apps disabled. Existing execution permissions are unchanged.");
    lines.push(immediate ? (request.delegation ? "The deployment delegation auto-applies this scoped request without another confirmation; it grants no Full Access." : "Full Access applies this request in the current turn without another confirmation.") : "After this decision the Chief continues once with the result.");
    const title = request.deletion ? `Delete @${request.deletion.name}?` : `Apply setup for ${request.operations.length} ${request.operations.length === 1 ? "bot" : "bots"}?`;
    const detail = lines.join("\n");
    return {
      title, subtitle: detail, options: [request.deletion ? "Delete bot" : "Apply setup", "Cancel"], requestId: request.requestId,
      tool: request.deletion ? "delete_bot" : "set_up_team", teamSetupRequest: request,
    };
  }

  private card(request: TeamSetupRequest, from?: RequestFrom) {
    const card = this.cardData(request);
    const message = this.options.store.appendMessage(request.threadId, { role: "bot", kind: "options", ...(from ? { from } : {}), card });
    const { title, subtitle: detail } = card;
    return { requestId: request.requestId, messageId: message.id, title, summary: title, detail };
  }

  private async apply(request: TeamSetupRequest, immediate = false, canCommit?: () => boolean): Promise<TeamSetupResult> {
    const receipt = this.options.store.bot(request.botId)?.lastTeamSetupReceipt;
    if (receipt?.requestId === request.requestId) return receipt.result;
    try {
      const revalidate = () => {
        // Deletion awaits inventory and teardown. A still-Full conversation
        // is not authority for an invocation that Stop/replacement revoked.
        if (immediate && canCommit && !canCommit()) throw new TeamSetupError("The requesting turn has expired; this setup was cancelled", 409);
        this.validate(request, true, immediate);
      };
      revalidate();
      if (request.remote) {
        const existing = this.options.store.messagesFor(request.threadId).find(m => m.card?.requestId === request.requestId);
        if (existing?.card?.teamSetupRequest?.remote?.dispatchStarted) return existing.card.teamSetupRequest.result ?? { state: "failed", bots: [], newTeams: [], error: "Remote outcome is unknown; dispatch was not replayed. Check the remote owner's receipt." };
        const result: TeamSetupResult = { state: "failed", bots: [], newTeams: [], error: "Remote outcome is unknown; dispatch was not replayed. Check the remote owner's receipt." };
        const card = { ...(existing?.card ?? this.cardData(request, immediate)), answered: "deny" as const,
          teamSetupRequest: { ...request, remote: { ...request.remote, dispatchStarted: true }, result } };
        // Synchronous durable message write precedes the external mutation. A crash fails closed.
        if (existing) this.options.store.patchMessage(request.threadId, existing.id, { card });
        else this.options.store.appendMessage(request.threadId, { role: "bot", kind: "options", card });
        return await this.options.applyRemote!(request);
      }
      if (!request.deletion) return this.options.store.applyTeamSetup(request);
      await this.options.deleteBot(request.deletion.botId, revalidate, request);
      return { state: "applied", bots: [{ id: request.deletion.botId, name: request.deletion.name, action: "deleted" }], newTeams: [] };
    } catch (error) {
      const saved = this.options.store.bot(request.botId)?.lastTeamSetupReceipt;
      const detail = redactSecretsInText(error instanceof Error ? error.message : String(error));
      return saved?.requestId === request.requestId
        ? { ...saved.result, error: `The changes were saved, but cleanup needs attention: ${detail}` }
        : { state: error instanceof TeamSetupError ? "cancelled" : "failed", bots: [], newTeams: [], error: detail };
    }
  }

  private async applyImmediately(request: TeamSetupRequest, from?: RequestFrom, canCommit?: () => boolean) {
    // Capture the before/after description before applying. Only a settled
    // receipt is published, so no interactive card or second turn can start.
    const card = this.cardData(request, true);
    let result = await this.apply(request, true, canCommit);
    const title = result.state === "pending" ? "Awaiting remote owner review" : result.state === "applied" ? (request.deletion ? `Deleted @${request.deletion.name}` : "Team setup applied") : "Team setup not applied";
    let messageId: string | undefined;
    try {
      const settled = { ...card, title, options: [], answered: result.state === "applied" || result.state === "pending" ? "allow" as const : "deny" as const, held: result.error,
        teamSetupRequest: { ...request, ...(request.remote ? { remote: { ...request.remote, dispatchStarted: true } } : {}), result, resumed: result.state !== "pending" } };
      const existing = request.remote && this.options.store.messagesFor(request.threadId).find(m => m.card?.requestId === request.requestId);
      if (existing) { this.options.store.patchMessage(request.threadId, existing.id, { card: settled }); messageId = existing.id; }
      else messageId = this.options.store.appendMessage(request.threadId, { role: "bot", kind: "options", ...(from ? { from } : {}), card: settled }).id;
    } catch (error) {
      // The atomic bot receipt remains authoritative if the chat write fails.
      const detail = redactSecretsInText(error instanceof Error ? error.message : String(error));
      result = { ...result, error: [result.error, `The result could not be added to the conversation: ${detail}`].filter(Boolean).join(" ") };
    }
    return { requestId: request.requestId, messageId, title, summary: title, detail: card.subtitle, applied: result.state === "applied", state: result.state, result };
  }

  async resolve(args: { botId: string; threadId: string; requestId: string; behavior: string }) {
    const message = this.options.store.messagesFor(args.threadId).find((item) => item.card?.requestId === args.requestId && item.card.teamSetupRequest);
    const card = message?.card, request = card?.teamSetupRequest;
    if (!message || !card || !request) return null;
    if (request.botId !== args.botId || request.threadId !== args.threadId || request.requestId !== args.requestId) throw new TeamSetupError("This setup belongs to another conversation", 403);
    if (args.behavior !== "allow" && args.behavior !== "deny") throw new TeamSetupError("Confirm or cancel this setup", 400);
    // Stop/dismiss can close a card without a setup decision. It must never
    // resurrect that review or wake the stopped conversation.
    if (card.answered || card.dismissed) {
      const result = request.result ?? { state: "cancelled" as const, bots: [], newTeams: [], error: "This setup card was closed" };
      return { result, request: { ...request, result }, messageId: message.id, duplicate: true };
    }
    if (this.resolving.has(request.requestId)) throw new TeamSetupError("This setup is already being applied", 409);
    this.resolving.add(request.requestId);
    try {
      const receipt = this.options.store.bot(request.botId)?.lastTeamSetupReceipt;
      let result: TeamSetupResult;
      if (receipt?.requestId === request.requestId) result = receipt.result;
      else if (args.behavior === "deny") result = { state: "denied", bots: [], newTeams: [] };
      else result = await this.apply(request);
      const durableRemote = this.options.store.messagesFor(args.threadId).find(m => m.id === message.id)?.card?.teamSetupRequest?.remote;
      if (durableRemote) request.remote = durableRemote;
      this.options.store.patchMessage(args.threadId, message.id, { card: { ...card, answered: result.state === "applied" || result.state === "pending" ? "allow" : "deny", held: result.error, teamSetupRequest: { ...request, result } } });
      return { result, request: { ...request, result }, messageId: message.id, duplicate: false };
    } finally { this.resolving.delete(request.requestId); }
  }
}
