/**
 * Durable payload carried by a setting-change card (propose_setting, 3.0).
 *
 * A bot asked in chat to change one of a bot's settings ("make cash use
 * haiku", "mute oracle") posts this card instead of changing anything. The
 * person applies it with one tap and can undo it afterwards. `before` is the
 * value the person was shown; apply proceeds only while the live value still
 * equals it, and undo only while the live value still equals `after`, so a
 * stale card can never clobber a newer change.
 */
import type { ModelSelection } from "./wire.ts";

export const SETTING_CHANGE_KEYS = ["model", "notifications", "pinned", "computer", "composio", "browser", "speakReplies"] as const;
export type SettingChangeKey = (typeof SETTING_CHANGE_KEYS)[number];

/** "Works on". auto is the absent durable field (PATCH sends null). */
export const SETTING_COMPUTER_VALUES = ["auto", "cloud", "vm", "local", "browser", "boxcompute", "off"] as const;
export type SettingComputerValue = (typeof SETTING_COMPUTER_VALUES)[number];

export type SettingChangeValue = boolean | SettingComputerValue | ModelSelection;

export interface SettingChangeCardData {
  version: 1;
  requestId: string;
  /** The proposing conversation; authority is fixed here. */
  botId: string;
  threadId: string;
  /** Whose setting changes: the proposer, or a section peer named by a Chief. */
  targetBotId: string;
  targetName: string;
  setting: SettingChangeKey;
  before: SettingChangeValue;
  after: SettingChangeValue;
  /** Plain words for the card: "model", "Sonnet 5.5", "Haiku 5.5". */
  settingLabel: string;
  beforeLabel: string;
  afterLabel: string;
  reason?: string;
  createdAt: number;
  appliedAt?: number;
  undoneAt?: number;
  declinedAt?: number;
}

export type SettingChangeAction = "apply" | "undo" | "decline";

/** The bot fields each setting reads, with the defaults the rest of the app uses. */
export interface SettingSource {
  modelSelection: ModelSelection;
  notifications?: boolean;
  pinned?: boolean;
  computer?: string;
  composio?: boolean;
  browser?: boolean;
  speakReplies?: boolean;
}

export function currentSettingValue(bot: SettingSource, setting: SettingChangeKey): SettingChangeValue {
  switch (setting) {
    case "model": {
      const { instanceId, model, effort, variant } = bot.modelSelection;
      return { instanceId, model, ...(effort !== undefined ? { effort } : {}), ...(variant !== undefined ? { variant } : {}) };
    }
    case "notifications": return bot.notifications !== false;
    case "pinned": return bot.pinned === true;
    case "computer": return (bot.computer ?? "auto") as SettingComputerValue;
    case "composio": return bot.composio !== false;
    case "browser": return bot.browser !== false;
    case "speakReplies": return bot.speakReplies === true;
  }
}

/** A stable comparison key: the "revision" a card is checked against. */
export function settingRevision(value: SettingChangeValue): string {
  if (typeof value === "object" && value !== null) {
    return JSON.stringify([value.instanceId, value.model, value.effort ?? null, value.variant ?? null]);
  }
  return JSON.stringify(value);
}

/** The exact PATCH /api/bots/:id fields the settings UI sends for this value. */
export function settingPatchBody(setting: SettingChangeKey, value: SettingChangeValue, requireAvailableModel = false): Record<string, unknown> {
  switch (setting) {
    case "model":
      return { modelSelection: value, ...(requireAvailableModel ? { requireAvailableModel: true } : {}) };
    case "computer":
      return { computer: value === "auto" ? null : value };
    default:
      return { [setting]: value };
  }
}
