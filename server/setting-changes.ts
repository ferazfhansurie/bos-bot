// propose_setting (3.0): a bot asked in chat to change a bot's setting posts
// a card; the person applies it with one tap and can undo it. Nothing here
// changes a bot by itself — not even under Full Access. Apply and undo are
// routed through PATCH /api/bots/:id (the settings UI's own path): begin()
// validates the card and turns it into that route's ordinary fields, the
// route does every check it always does, and commit() stamps the card only
// once the route has saved. Same shape as profile-requests.ts, smaller.
import {
  SETTING_COMPUTER_VALUES,
  currentSettingValue,
  settingPatchBody,
  settingRevision,
  type SettingChangeAction,
  type SettingChangeCardData,
  type SettingChangeKey,
  type SettingChangeValue,
  type SettingComputerValue,
} from "../shared/setting-change.ts";
import type { ModelSelection } from "../shared/wire.ts";
import { newId } from "./contracts.ts";
import { redactSecretsInText } from "./redact.ts";
import type { BotRecord } from "./store.ts";

const MAX_REASON = 500;
const MAX_OPEN_PER_THREAD = 8;
const MAX_CHOICES_LISTED = 15;
export const SETTING_CHANGE_TOOL = "change_setting";
const STALE = "This setting changed after the card was prepared, so it was left alone. Ask the bot to propose it again.";
const UNDO_STALE = "This setting changed again after it was applied, so undo would overwrite the newer value. Change it in settings instead.";

/** What the bot may call each setting; the card stores the canonical key. */
const SETTING_ALIASES: Record<string, SettingChangeKey> = {
  model: "model",
  notifications: "notifications",
  notify: "notifications",
  pinned: "pinned",
  pin: "pinned",
  computer: "computer",
  works_on: "computer",
  apps: "composio",
  composio: "composio",
  browser: "browser",
  speak_replies: "speakReplies",
  speakreplies: "speakReplies",
};

const SETTING_LABELS: Record<SettingChangeKey, string> = {
  model: "model",
  notifications: "notifications",
  pinned: "pinned",
  computer: "works on",
  composio: "apps",
  browser: "browser",
  speakReplies: "speak replies",
};

const COMPUTER_LABELS: Record<SettingComputerValue, string> = {
  auto: "auto",
  cloud: "cloud computer",
  vm: "virtual machine",
  local: "this computer",
  browser: "browser only",
  boxcompute: "BoxCompute",
  off: "no computer",
};

export interface OptionCardLike {
  title: string;
  subtitle: string;
  options: string[];
  answered?: string;
  dismissed?: boolean;
  requestId?: string;
  tool?: string;
  settingChange?: SettingChangeCardData;
}

/** One provider instance's offered models, as the registry reports them. */
export interface SettingCatalogInstance {
  instanceId: string;
  displayName?: string;
  models: { default: string; options: Array<{ id: string; label: string }> };
}

/** Kept narrow so the domain can be tested without the full app store. */
export interface SettingChangeStore {
  bot(id: string): BotRecord | undefined | null;
  messagesFor(threadId: string): Array<{ id: string; card?: OptionCardLike }>;
  appendMessage(
    threadId: string,
    message: { role: "bot"; kind: "options"; card: OptionCardLike; from?: { botId: string; name: string; color: string } },
  ): { id: string };
  patchMessage(threadId: string, messageId: string, patch: { card: OptionCardLike }): { id: string } | null;
}

export interface SettingChangeServiceOptions {
  store: SettingChangeStore;
  /** Enabled, shipped provider instances: the only source of model ids. */
  catalog: () => SettingCatalogInstance[];
  /** The server switch (features.v3, the 3.0 switch). Off refuses new cards and apply. */
  enabled: () => boolean;
  now?: () => number;
  /** Chief targeting another bot: a refusal sentence or null. Checked at propose AND apply. */
  validateTarget?: (proposerBotId: string, targetBotId: string) => string | null;
  /** A setting this server cannot apply right now: a refusal sentence or null. */
  unavailable?: (setting: SettingChangeKey, target: BotRecord) => string | null;
}

export class SettingChangeError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "SettingChangeError";
    this.status = status;
  }
}

export interface SettingChangeTicket {
  threadId: string;
  messageId: string;
  requestId: string;
  action: Exclude<SettingChangeAction, "decline">;
}

export type SettingChangeBegin = { kind: "settled" } | { kind: "patch"; ticket: SettingChangeTicket };

function parseSetting(input: unknown): SettingChangeKey {
  const key = typeof input === "string" ? SETTING_ALIASES[input.trim().toLowerCase()] : undefined;
  if (!key) {
    throw new SettingChangeError(`setting must be one of model, notifications, pinned, computer, apps, browser, speak_replies`);
  }
  return key;
}

function parseBoolean(setting: SettingChangeKey, input: unknown): boolean {
  if (typeof input === "boolean") return input;
  if (typeof input === "string") {
    const word = input.trim().toLowerCase();
    if (["on", "true", "yes", "enabled"].includes(word)) return true;
    if (["off", "false", "no", "disabled"].includes(word)) return false;
  }
  throw new SettingChangeError(`${SETTING_LABELS[setting]} must be on or off`);
}

function parseComputer(input: unknown): SettingComputerValue {
  if (input === null || input === undefined) return "auto";
  const word = typeof input === "string" ? input.trim().toLowerCase() : "";
  const value = word === "unset" || word === "" ? "auto" : word;
  if (!(SETTING_COMPUTER_VALUES as readonly string[]).includes(value)) {
    throw new SettingChangeError(`computer must be one of ${SETTING_COMPUTER_VALUES.join(", ")}`);
  }
  return value as SettingComputerValue;
}

function reasonText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new SettingChangeError("reason must be text");
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > MAX_REASON) throw new SettingChangeError(`reason must be ${MAX_REASON} characters or fewer`);
  return redactSecretsInText(trimmed);
}

interface CatalogEntry {
  instanceId: string;
  instanceName: string;
  id: string;
  label: string;
}

function catalogEntries(instances: SettingCatalogInstance[]): CatalogEntry[] {
  const seen = new Set<string>();
  const entries: CatalogEntry[] = [];
  for (const instance of instances) {
    const instanceName = instance.displayName?.trim() || instance.instanceId;
    const options = instance.models.options.some((option) => option.id === instance.models.default) || !instance.models.default
      ? instance.models.options
      : [{ id: instance.models.default, label: instance.models.default }, ...instance.models.options];
    for (const option of options) {
      const key = `${instance.instanceId}\u0000${option.id}`;
      if (!option.id || seen.has(key)) continue;
      seen.add(key);
      entries.push({ instanceId: instance.instanceId, instanceName, id: option.id, label: option.label?.trim() || option.id });
    }
  }
  return entries;
}

const describeEntry = (entry: CatalogEntry) => `${entry.label} (${entry.id} on ${entry.instanceId})`;

export class SettingChangeService {
  private readonly store: SettingChangeStore;
  private readonly catalog: () => SettingCatalogInstance[];
  private readonly enabled: () => boolean;
  private readonly now: () => number;
  private readonly unavailable?: SettingChangeServiceOptions["unavailable"];
  /** Public: section membership can change between propose and apply. */
  validateTarget?: SettingChangeServiceOptions["validateTarget"];

  constructor(options: SettingChangeServiceOptions) {
    this.store = options.store;
    this.catalog = options.catalog;
    this.enabled = options.enabled;
    this.now = options.now ?? Date.now;
    this.unavailable = options.unavailable;
    this.validateTarget = options.validateTarget;
  }

  /** Post the card. Never changes the bot. */
  propose(args: {
    botId: string;
    threadId: string;
    targetBotId?: string;
    setting: unknown;
    value: unknown;
    instanceId?: unknown;
    reason?: unknown;
    from?: { botId: string; name: string; color: string };
  }): { state: "pending"; requestId: string; messageId: string; summary: string } {
    if (!this.enabled()) throw new SettingChangeError("setting cards are turned off in this workspace", 403);
    const proposer = this.store.bot(args.botId);
    if (!proposer) throw new SettingChangeError("unknown sender", 403);
    const targetBotId = args.targetBotId?.trim() || proposer.id;
    const target = this.store.bot(targetBotId);
    if (!target) throw new SettingChangeError("That bot no longer exists", 404);
    if (target.id !== proposer.id) {
      const refusal = this.validateTarget
        ? this.validateTarget(proposer.id, target.id)
        : "only a section's Chief of Staff can change another bot's settings";
      if (refusal) throw new SettingChangeError(refusal, 403);
    }
    const setting = parseSetting(args.setting);
    const refusal = this.unavailable?.(setting, target);
    if (refusal) throw new SettingChangeError(refusal, 409);
    const reason = reasonText(args.reason);
    const before = currentSettingValue(target, setting);
    const after = this.parseValue(setting, args.value, args.instanceId, before);
    if (settingRevision(before) === settingRevision(after)) {
      throw new SettingChangeError(`${target.name}'s ${SETTING_LABELS[setting]} is already ${this.valueLabel(setting, after, before)}; nothing to change`, 409);
    }
    const open = this.store.messagesFor(args.threadId).filter((message) => {
      const payload = message.card?.settingChange;
      return payload?.botId === proposer.id && !payload.appliedAt && !payload.declinedAt && !payload.undoneAt;
    }).length;
    if (open >= MAX_OPEN_PER_THREAD) {
      throw new SettingChangeError("apply or dismiss an existing setting card first", 429);
    }

    const payload: SettingChangeCardData = {
      version: 1,
      requestId: newId(),
      botId: proposer.id,
      threadId: args.threadId,
      targetBotId: target.id,
      targetName: target.name,
      setting,
      before,
      after,
      settingLabel: SETTING_LABELS[setting],
      beforeLabel: this.valueLabel(setting, before, after),
      afterLabel: this.valueLabel(setting, after, before),
      ...(reason ? { reason } : {}),
      createdAt: this.now(),
    };
    const summary = settingChangeSummary(payload);
    const message = this.store.appendMessage(args.threadId, {
      role: "bot",
      kind: "options",
      card: {
        title: `Change ${target.name}'s ${payload.settingLabel}?`,
        subtitle: summary,
        options: [],
        // Answered on the card itself, never through the composer's approval
        // lane: dismissed keeps it out of pendingApprovals, the restart/turn
        // sweeps and needs-me, none of which can apply it.
        dismissed: true,
        requestId: payload.requestId,
        tool: SETTING_CHANGE_TOOL,
        settingChange: payload,
      },
      ...(args.from ? { from: args.from } : {}),
    });
    return { state: "pending", requestId: payload.requestId, messageId: message.id, summary };
  }

  /**
   * The person tapped Apply / Undo / Not now. Validates the card against the
   * live bot and, for apply and undo, rewrites `body` into the plain PATCH
   * fields the settings UI would send. The route saves them; commit() then
   * stamps the card. A refusal throws SettingChangeError with its status.
   */
  begin(targetBotId: string, body: Record<string, unknown>): SettingChangeBegin {
    const request = body.settingChange;
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      throw new SettingChangeError("settingChange must be an object");
    }
    const others = Object.keys(body).filter((key) => key !== "settingChange");
    if (others.length) throw new SettingChangeError(`settingChange cannot be combined with ${others.join(", ")}`);
    const { threadId, requestId, action } = request as Record<string, unknown>;
    if (typeof threadId !== "string" || typeof requestId !== "string" || !threadId || !requestId) {
      throw new SettingChangeError("settingChange needs threadId and requestId");
    }
    if (action !== "apply" && action !== "undo" && action !== "decline") {
      throw new SettingChangeError("settingChange.action must be apply, undo or decline");
    }
    const found = this.find(threadId, requestId);
    if (!found) throw new SettingChangeError("That setting card no longer exists", 404);
    const { message, payload } = found;
    if (payload.targetBotId !== targetBotId) throw new SettingChangeError("That card changes a different bot");
    const target = this.store.bot(targetBotId);
    if (!target) throw new SettingChangeError("That bot no longer exists", 404);
    const current = settingRevision(currentSettingValue(target, payload.setting));

    if (action === "decline") {
      if (payload.appliedAt || payload.declinedAt || payload.undoneAt) throw new SettingChangeError("This card is already settled", 409);
      this.stamp(threadId, message.id, { ...payload, declinedAt: this.now() }, "deny");
      return { kind: "settled" };
    }

    let value: SettingChangeValue;
    if (action === "apply") {
      if (payload.declinedAt) throw new SettingChangeError("This card was dismissed", 409);
      if (payload.appliedAt) throw new SettingChangeError("This change is already applied", 409);
      if (!this.enabled()) throw new SettingChangeError("setting cards are turned off in this workspace", 403);
      if (payload.botId !== payload.targetBotId) {
        const refusal = this.validateTarget
          ? this.validateTarget(payload.botId, payload.targetBotId)
          : "only a section's Chief of Staff can change another bot's settings";
        if (refusal) throw new SettingChangeError(refusal, 403);
      }
      const refusal = this.unavailable?.(payload.setting, target);
      if (refusal) throw new SettingChangeError(refusal, 409);
      if (current !== settingRevision(payload.before)) throw new SettingChangeError(STALE, 409);
      if (payload.setting === "model") this.assertOffered(payload.after as ModelSelection);
      value = payload.after;
    } else {
      if (!payload.appliedAt) throw new SettingChangeError("Only an applied change can be undone", 409);
      if (payload.undoneAt) throw new SettingChangeError("This change is already undone", 409);
      if (current !== settingRevision(payload.after)) throw new SettingChangeError(UNDO_STALE, 409);
      value = payload.before;
    }
    delete body.settingChange;
    // Apply requires the model to be one the catalog still offers; undo
    // restores exactly what the bot had, which is always a known value.
    Object.assign(body, settingPatchBody(payload.setting, value, action === "apply"));
    return { kind: "patch", ticket: { threadId, messageId: message.id, requestId, action } };
  }

  /** The route saved the patch: record it on the card. */
  commit(ticket: SettingChangeTicket): void {
    const found = this.find(ticket.threadId, ticket.requestId);
    if (!found) return;
    const at = this.now();
    const next = ticket.action === "apply"
      ? { ...found.payload, appliedAt: at }
      : { ...found.payload, undoneAt: at };
    this.stamp(ticket.threadId, found.message.id, next, "allow");
  }

  private find(threadId: string, requestId: string) {
    for (const message of this.store.messagesFor(threadId)) {
      const payload = message.card?.settingChange;
      if (payload?.requestId === requestId && message.card) return { message: message as { id: string; card: OptionCardLike }, payload };
    }
    return null;
  }

  private stamp(threadId: string, messageId: string, payload: SettingChangeCardData, answered: "allow" | "deny") {
    const message = this.store.messagesFor(threadId).find((candidate) => candidate.id === messageId);
    if (!message?.card) return;
    this.store.patchMessage(threadId, messageId, { card: { ...message.card, answered, dismissed: true, settingChange: payload } });
  }

  private parseValue(setting: SettingChangeKey, input: unknown, instanceId: unknown, before: SettingChangeValue): SettingChangeValue {
    if (setting === "model") return this.resolveModel(input, instanceId, before as ModelSelection);
    if (setting === "computer") return parseComputer(input);
    return parseBoolean(setting, input);
  }

  /** Match a model id or its catalog label. Never invents an id: the result
   * is always an option a live instance offers. */
  private resolveModel(input: unknown, instanceHint: unknown, current: ModelSelection): ModelSelection {
    if (typeof input !== "string" || !input.trim()) throw new SettingChangeError("model needs a model id or name from the catalog");
    const query = input.trim().toLowerCase();
    const hint = typeof instanceHint === "string" && instanceHint.trim() ? instanceHint.trim() : undefined;
    const all = catalogEntries(this.catalog());
    const scope = hint ? all.filter((entry) => entry.instanceId === hint) : all;
    if (hint && !scope.length) throw new SettingChangeError(`no available engine "${hint}"`);
    const pick = (list: CatalogEntry[]): CatalogEntry | undefined => {
      if (list.length === 1) return list[0];
      const own = list.filter((entry) => entry.instanceId === current.instanceId);
      return own.length === 1 ? own[0] : undefined;
    };
    const exact = scope.filter((entry) => entry.id.toLowerCase() === query || entry.label.toLowerCase() === query);
    const partial = exact.length ? exact : scope.filter((entry) => entry.id.toLowerCase().includes(query) || entry.label.toLowerCase().includes(query));
    const choice = pick(partial);
    if (!choice) {
      const listed = (partial.length ? partial : scope).slice(0, MAX_CHOICES_LISTED).map(describeEntry).join("; ");
      throw new SettingChangeError(partial.length
        ? `"${input.trim()}" matches several models. Pass the exact model id and instance_id. Matches: ${listed}`
        : `no available model matches "${input.trim()}". Choose one of: ${listed || "(no models are available)"}`);
    }
    const selection: ModelSelection = { instanceId: choice.instanceId, model: choice.id };
    // Effort levels belong to the engine, so they carry over within one.
    if (choice.instanceId === current.instanceId && current.effort !== undefined) selection.effort = current.effort;
    return selection;
  }

  private assertOffered(selection: ModelSelection) {
    const offered = catalogEntries(this.catalog()).some((entry) => entry.instanceId === selection.instanceId && entry.id === selection.model);
    if (!offered) throw new SettingChangeError(`model "${selection.model}" is no longer offered; ask the bot to propose another`);
  }

  private valueLabel(setting: SettingChangeKey, value: SettingChangeValue, other: SettingChangeValue): string {
    if (setting === "model") {
      const selection = value as ModelSelection;
      const entry = catalogEntries(this.catalog()).find((candidate) => candidate.instanceId === selection.instanceId && candidate.id === selection.model);
      const label = entry?.label ?? selection.model;
      // Two engines can offer the same label; name the engine only when it moves.
      const otherInstance = (other as ModelSelection).instanceId;
      return otherInstance !== selection.instanceId ? `${label} (${entry?.instanceName ?? selection.instanceId})` : label;
    }
    if (setting === "computer") return COMPUTER_LABELS[value as SettingComputerValue] ?? String(value);
    if (setting === "notifications") return value ? "on" : "muted";
    if (setting === "pinned") return value ? "pinned" : "not pinned";
    return value ? "on" : "off";
  }
}

export function settingChangeSummary(payload: Pick<SettingChangeCardData, "targetName" | "settingLabel" | "beforeLabel" | "afterLabel">): string {
  return `${payload.targetName}: ${payload.settingLabel} ${payload.beforeLabel} → ${payload.afterLabel}`;
}
