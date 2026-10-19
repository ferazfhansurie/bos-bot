import { approvalCarriesAcrossModelSwitch, approvalModeFor, type ApprovalMode } from "../shared/approval-mode.ts";
import { isProviderSafetyBlock } from "../shared/provider-safety.ts";
import { newId, type ModelSelection, type ProviderInstance, type RuntimeEvent } from "./contracts.ts";
import type { ProviderUsage } from "./provider-usage.ts";
import type { Store } from "./store.ts";

/** Explicit exhaustion only: credentials, ordinary billing setup, network
 * failures and safety refusals wrapped in 429 never trigger a provider change. */
export function isProviderLimit(message: string): boolean {
  if (isProviderSafetyBlock(message) || /\b(?:40[13]|unauthorized|forbidden|invalid api key|not logged in|interrupted|cancelled)\b/i.test(message)) return false;
  return /\b429\b|\brate.?limit\b|\btoo many requests\b|\bquota (?:exceeded|exhausted)\b|\b(?:usage|spend|credit|token) limit\b|\bhit your .{0,80}limit\b/i.test(message);
}

/** The signed-in account cannot use this model at all: a plan gate (Codex on
 * a free ChatGPT account has no Sol models) or a retired id. Unlike a quota
 * limit it never resets, so the switch it triggers is permanent. */
export function isModelUnavailable(message: string): boolean {
  if (!message || isProviderSafetyBlock(message) || isProviderLimit(message)) return false;
  return /\bmodel is not supported when using codex\b|\bnot supported when using codex with a chatgpt account\b|\b(?:does not|do not|don't) have access to (?:the )?model\b|\bmodel_not_found\b|\bmodel not found\b|\bunknown model\b|\bmodel (?:is )?not available (?:on|for) (?:your|this) (?:plan|account)\b/i.test(message);
}

/** The model id a provider named in its refusal ("The 'gpt-6.1-sol' model is
 * not supported ..."), when it named one. */
export function unavailableModelIn(message: string): string | null {
  const match = /['"`]([\w][\w./:+-]*)['"`]\s+model\b|\bmodel\s+['"`]([\w][\w./:+-]*)['"`]/i.exec(message);
  return match ? (match[1] ?? match[2]) : null;
}

/** Best replacement the same subscription offers: its own default, else the
 * first official row. Custom/local rows and known-refused ids never qualify. */
export function replacementModel(instance: ProviderInstance, refused: ReadonlySet<string>): string | null {
  const official = instance.models.options.filter(option => !option.custom && !refused.has(option.id));
  if (!refused.has(instance.models.default) && official.some(option => option.id === instance.models.default)) return instance.models.default;
  return official[0]?.id ?? null;
}

export function fallbackSelection(model: string, instances: readonly ProviderInstance[], preferred?: string): ModelSelection | null {
  const source = instances.find(instance => instance.instanceId === preferred);
  // A model-only fallback never authorizes borrowing a sibling subscription.
  const offered = instances.filter(instance =>
    !(source?.driverKind === "claudeAgent" && instance.driverKind === "claudeAgent" && instance.instanceId !== preferred) &&
    (instance.models.default === model || instance.models.options.some(option => option.id === model)));
  const same = offered.find(instance => instance.instanceId === preferred);
  const target = same ?? (offered.length === 1 ? offered[0] : undefined);
  return target ? { instanceId: target.instanceId, model } : null;
}
const sameSelection = (a: ModelSelection, b: ModelSelection) => a.instanceId === b.instanceId && a.model === b.model && a.effort === b.effort && a.variant === b.variant;
const windows = (row?: ProviderUsage) => row?.status === "available" ? [row.fiveHour, row.sevenDay].filter(window => window !== undefined) : [];
const exhaustion = (row?: ProviderUsage) => windows(row).filter(window => window.usedPercent !== null && window.usedPercent >= 100);
interface Options {
  store: Store;
  instances: () => ProviderInstance[];
  usage: () => Promise<ProviderUsage[]>;
  keepPermissions: () => boolean;
  changing: (instanceId: string) => boolean;
  publish: (event: RuntimeEvent) => void;
  roomBusy?: (threadId: string) => boolean;
  now?: () => number;
}

/** Changes only idle tasks. Every await is followed by authority and model
 * revalidation; the bot default, other tasks and approval settings stay intact. */
export class ModelFallbackService {
  private readonly now: () => number;
  private readonly options: Options;
  constructor(options: Options) { this.options = options; this.now = options.now ?? Date.now; }
  roomSelection(botId: string, threadId: string): ModelSelection | undefined {
    const bot = this.options.store.bot(botId);
    const marker = bot?.roomModelFallbacks?.[threadId];
    return marker && bot?.fallbackModel === marker.to.model && sameSelection(bot.modelSelection, marker.from)
      ? structuredClone(marker.to) : bot?.modelSelection;
  }
  private roomCompatible(botId: string, threadId: string, from: ModelSelection, to: ModelSelection, mode: ApprovalMode) {
    const bot = this.options.store.bot(botId);
    const source = this.options.instances().find(instance => instance.instanceId === from.instanceId);
    const target = this.options.instances().find(instance => instance.instanceId === to.instanceId);
    return bot && !bot.approvalGrant && !this.options.roomBusy?.(threadId) && source && target &&
      !this.options.changing(source.instanceId) && !this.options.changing(target.instanceId) &&
      approvalCarriesAcrossModelSwitch(mode, source.driverKind, target.driverKind, this.options.keepPermissions());
  }
  async beforeRoomTurn(botId: string, threadId: string, mode: ApprovalMode, guard: () => boolean = () => true): Promise<ModelSelection | undefined> {
    let bot = this.options.store.bot(botId);
    if (!bot?.fallbackModel) return bot?.modelSelection;
    const rows = await this.options.usage();
    await this.restore(rows, threadId);
    bot = this.options.store.bot(botId);
    if (!bot || !guard()) return undefined;
    const existing = bot.roomModelFallbacks?.[threadId];
    if (existing) {
      return this.roomCompatible(botId, threadId, existing.from, existing.to, mode) ? this.roomSelection(botId, threadId) : bot.modelSelection;
    }
    const from = structuredClone(bot.modelSelection);
    const targetSelection = fallbackSelection(bot.fallbackModel!, this.options.instances(), from.instanceId);
    const exhausted = exhaustion(rows.find(row => row.instanceId === from.instanceId));
    if (!targetSelection || !exhausted.length || exhaustion(rows.find(row => row.instanceId === targetSelection.instanceId)).length ||
        !this.roomCompatible(botId, threadId, from, targetSelection, mode)) return from;
    const sourceSnapshot = await this.options.instances().find(instance => instance.instanceId === from.instanceId)!.snapshot();
    if (sourceSnapshot.authenticated === false) return from;
    const snapshot = await this.options.instances().find(instance => instance.instanceId === targetSelection.instanceId)!.snapshot();
    const fresh = this.options.store.bot(botId);
    if (!guard() || snapshot.state !== "available" || snapshot.authenticated === false || !fresh ||
        fresh.fallbackModel !== bot.fallbackModel || !sameSelection(fresh.modelSelection, from) ||
        !this.roomCompatible(botId, threadId, from, targetSelection, mode)) return this.roomSelection(botId, threadId);
    const resetAt = exhausted.every(window => window.resetsAt !== null) ? Math.max(...exhausted.map(window => window.resetsAt! * 1000)) : null;
    this.options.store.patchBot(botId, { roomModelFallbacks: { ...fresh.roomModelFallbacks, [threadId]: {
      from, to: targetSelection, mode, switchedAt: this.now(), resetAt,
    } } });
    this.event(botId, threadId, from, targetSelection, "provider_limit");
    return targetSelection;
  }
  async beforeTurn(botId: string, threadId: string): Promise<boolean> {
    const bot = this.options.store.bot(botId);
    if (!bot?.fallbackModel) return false;
    const rows = await this.options.usage();
    await this.restore(rows, threadId);
    const current = this.options.store.projectBotForTask(botId, threadId);
    if (!current || this.options.store.taskByThread(botId, threadId)?.modelFallback) return false;
    const row = rows.find(row => row.instanceId === current.modelSelection.instanceId);
    if (!exhaustion(row).length) return false;
    return this.switch(botId, threadId, rows);
  }
  async afterFailure(botId: string, threadId: string, message: string, effects: boolean, guard: () => boolean = () => true): Promise<boolean> {
    if (effects || !isProviderLimit(message)) return false;
    return this.switch(botId, threadId, await this.options.usage(), guard);
  }
  private compatible(botId: string, threadId: string, selection: ModelSelection) {
    const current = this.options.store.projectBotForTask(botId, threadId);
    const instances = this.options.instances();
    const from = instances.find(instance => instance.instanceId === current?.modelSelection.instanceId);
    const to = instances.find(instance => instance.instanceId === selection.instanceId);
    return current && !current.busy && !current.approvalGrant && from && to &&
      !this.options.changing(from.instanceId) && !this.options.changing(to.instanceId) &&
      approvalCarriesAcrossModelSwitch(approvalModeFor(current), from.driverKind, to.driverKind, this.options.keepPermissions());
  }
  private async switch(botId: string, threadId: string, rows: ProviderUsage[], guard: () => boolean = () => true): Promise<boolean> {
    const bot = this.options.store.projectBotForTask(botId, threadId);
    const task = this.options.store.taskByThread(botId, threadId);
    if (!guard() || !bot?.fallbackModel || task?.modelFallback) return false;
    const selection = fallbackSelection(bot.fallbackModel, this.options.instances(), bot.modelSelection.instanceId);
    if (!selection || sameSelection(selection, bot.modelSelection) || !this.compatible(botId, threadId, selection)) return false;
    if (exhaustion(rows.find(row => row.instanceId === selection.instanceId)).length) return false;
    const target = this.options.instances().find(instance => instance.instanceId === selection.instanceId)!;
    const sourceSnapshot = await this.options.instances().find(instance => instance.instanceId === bot.modelSelection.instanceId)!.snapshot();
    if (sourceSnapshot.authenticated === false) return false;
    const snapshot = await target.snapshot();
    if (snapshot.state !== "available" || snapshot.authenticated === false || !this.compatible(botId, threadId, selection)) return false;
    const fresh = this.options.store.projectBotForTask(botId, threadId);
    if (!guard() || !fresh || fresh.fallbackModel !== bot.fallbackModel || !sameSelection(fresh.modelSelection, bot.modelSelection) || this.options.store.taskByThread(botId, threadId)?.modelFallback) return false;
    const sourceUsage = rows.find(row => row.instanceId === bot.modelSelection.instanceId);
    const exhausted = exhaustion(sourceUsage);
    // Error classification can lead telemetry. Use known future window resets,
    // and stay on the backup when there is no actual reset evidence.
    const resetWindows = exhausted.length ? exhausted : windows(sourceUsage).filter(window => window.resetsAt !== null && window.resetsAt * 1000 > this.now());
    const resetAt = resetWindows.length && resetWindows.every(window => window.resetsAt !== null)
      ? Math.max(...resetWindows.map(window => window.resetsAt! * 1000)) : null;
    this.options.store.switchTaskModel(botId, threadId, selection, false, false, { modelFallback: {
      from: bot.modelSelection, to: selection, switchedAt: this.now(), resetAt,
    } });
    this.event(botId, threadId, bot.modelSelection, selection, "provider_limit");
    return true;
  }
  async restore(rows?: ProviderUsage[], onlyThread?: string): Promise<number> {
    const candidates = this.options.store.bots.flatMap(bot => (bot.tasks ?? []).filter(task => task.modelFallback && (!onlyThread || task.threadId === onlyThread)).map(task => ({ botId: bot.id, threadId: task.threadId })));
    const roomCandidates = this.options.store.bots.flatMap(bot => Object.keys(bot.roomModelFallbacks ?? {}).filter(threadId => !onlyThread || onlyThread === threadId).map(threadId => ({ botId: bot.id, threadId })));
    if (!candidates.length && !roomCandidates.length) return 0;
    rows ??= await this.options.usage();
    let restored = 0;
    for (const { botId, threadId } of candidates) {
      const current = this.options.store.projectBotForTask(botId, threadId);
      const marker = this.options.store.taskByThread(botId, threadId)?.modelFallback;
      if (!current || !marker || current.busy) continue;
      if (!sameSelection(current.modelSelection, marker.to) || current.fallbackModel !== marker.to.model) {
        this.options.store.patchTask(botId, threadId, { modelFallback: undefined });
        continue;
      }
      if (marker.resetAt === null || this.now() < marker.resetAt) continue;
      const row = rows.find(row => row.instanceId === marker.from.instanceId);
      if (!windows(row).length || !windows(row).every(window => window.usedPercent !== null && window.usedPercent < 100) || !this.compatible(botId, threadId, marker.from)) continue;
      const target = this.options.instances().find(instance => instance.instanceId === marker.from.instanceId)!;
      if (!fallbackSelection(marker.from.model, [target])) continue;
      const snapshot = await target.snapshot();
      const fresh = this.options.store.taskByThread(botId, threadId);
      if (snapshot.state !== "available" || snapshot.authenticated === false || fresh?.modelFallback !== marker || !this.compatible(botId, threadId, marker.from)) continue;
      this.options.store.switchTaskModel(botId, threadId, marker.from, false, false, { modelFallback: undefined });
      this.event(botId, threadId, marker.to, marker.from, "provider_reset");
      restored++;
    }
    for (const { botId, threadId } of roomCandidates) {
      const bot = this.options.store.bot(botId);
      const marker = bot?.roomModelFallbacks?.[threadId];
      if (!bot || !marker || this.options.roomBusy?.(threadId)) continue;
      const clear = () => {
        const fresh = this.options.store.bot(botId);
        if (fresh?.roomModelFallbacks?.[threadId] !== marker) return;
        const next = { ...fresh.roomModelFallbacks }; delete next[threadId];
        this.options.store.patchBot(botId, { roomModelFallbacks: next });
      };
      if (!sameSelection(bot.modelSelection, marker.from) || bot.fallbackModel !== marker.to.model) { clear(); continue; }
      if (marker.resetAt === null || this.now() < marker.resetAt) continue;
      const row = rows.find(row => row.instanceId === marker.from.instanceId);
      if (!windows(row).length || !windows(row).every(window => window.usedPercent !== null && window.usedPercent < 100) ||
          !this.roomCompatible(botId, threadId, marker.to, marker.from, marker.mode)) continue;
      const target = this.options.instances().find(instance => instance.instanceId === marker.from.instanceId)!;
      if (!fallbackSelection(marker.from.model, [target])) continue;
      const snapshot = await target.snapshot();
      const fresh = this.options.store.bot(botId);
      if (snapshot.state !== "available" || snapshot.authenticated === false || fresh?.roomModelFallbacks?.[threadId] !== marker ||
          !sameSelection(fresh.modelSelection, marker.from) || fresh.fallbackModel !== marker.to.model ||
          !this.roomCompatible(botId, threadId, marker.to, marker.from, marker.mode)) continue;
      clear();
      this.event(botId, threadId, marker.to, marker.from, "provider_reset");
      restored++;
    }
    return restored;
  }
  /** Instance → model ids its account refused outright. */
  private readonly refused = new Map<string, Set<string>>();
  refusedModels(instanceId: string): ReadonlySet<string> { return this.refused.get(instanceId) ?? new Set(); }
  /** The account refused `failed`: move every bot default and thread pinned to
   * it on that instance to the best model the account does offer, so neither
   * this conversation nor any other hits the same refusal again. Returns the
   * replacement when this thread now runs on a usable model (already switched
   * by an earlier copy of the same error counts), else null. */
  replaceUnavailable(botId: string, threadId: string | null, failed: ModelSelection, message: string): ModelSelection | null {
    const named = unavailableModelIn(message);
    const model = named ?? failed.model;
    const instance = this.options.instances().find(candidate => candidate.instanceId === failed.instanceId);
    if (!instance) return null;
    const refused = this.refused.get(instance.instanceId) ?? new Set<string>();
    refused.add(model);
    this.refused.set(instance.instanceId, refused);
    if (failed.model !== model) {
      // A second copy of the same refusal after the switch already landed.
      return failed.model && !refused.has(failed.model) ? failed : null;
    }
    const target = replacementModel(instance, refused);
    if (!target) return null;
    const pinned = (selection?: ModelSelection) => selection?.instanceId === instance.instanceId && selection.model === model;
    const current = threadId ? this.options.store.projectBotForTask(botId, threadId)?.modelSelection : this.options.store.bot(botId)?.modelSelection;
    // The provider repeats one refusal (an error notification, then the failed
    // turn): the first copy switched it, later copies only confirm.
    if (current && !pinned(current) && !refused.has(current.model)) return current;
    const next = (selection: ModelSelection): ModelSelection => ({ instanceId: instance.instanceId, model: target, ...(selection.effort ? { effort: selection.effort } : {}) });
    for (const bot of this.options.store.bots) {
      if (pinned(bot.modelSelection)) this.options.store.patchBot(bot.id, { modelSelection: next(bot.modelSelection) });
      for (const task of bot.tasks ?? []) {
        if (pinned(task.modelSelection)) this.options.store.patchTask(bot.id, task.threadId, { modelSelection: next(task.modelSelection!), modelFallback: undefined });
      }
      const rooms = Object.entries(bot.roomModelFallbacks ?? {}).filter(([, marker]) => pinned(marker.to));
      if (rooms.length) {
        const kept = { ...bot.roomModelFallbacks };
        for (const [room] of rooms) delete kept[room];
        this.options.store.patchBot(bot.id, { roomModelFallbacks: kept });
      }
    }
    const to = (threadId ? this.options.store.projectBotForTask(botId, threadId)?.modelSelection : null) ??
      this.options.store.bot(botId)?.modelSelection ?? null;
    if (!to || pinned(to)) return null;
    if (threadId) this.event(botId, threadId, failed, to, "model_unavailable");
    return to;
  }
  private event(botId: string, threadId: string, from: ModelSelection, to: ModelSelection, reason: "provider_limit" | "provider_reset" | "model_unavailable") {
    this.options.publish({ type: "model.switched", eventId: newId(), provider: "harness", createdAt: new Date(this.now()).toISOString(), botId, threadId, from: from.model, to: to.model, reason });
  }
}
