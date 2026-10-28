import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { settingRevision } from "../shared/setting-change.ts";
import {
  SettingChangeError,
  SettingChangeService,
  type OptionCardLike,
  type SettingCatalogInstance,
  type SettingChangeStore,
} from "./setting-changes.ts";
import type { BotRecord } from "./store.ts";

interface StoredMessage {
  id: string;
  card?: OptionCardLike;
}

class MemoryStore implements SettingChangeStore {
  readonly bots = new Map<string, BotRecord>();
  readonly threads = new Map<string, StoredMessage[]>();
  private sequence = 0;

  bot(id: string): BotRecord | undefined {
    return this.bots.get(id);
  }

  messagesFor(threadId: string): StoredMessage[] {
    return this.threads.get(threadId) ?? [];
  }

  appendMessage(threadId: string, message: { role: "bot"; kind: "options"; card: OptionCardLike }): StoredMessage {
    const stored: StoredMessage = { id: `message-${++this.sequence}`, card: structuredClone(message.card) };
    this.threads.set(threadId, [...this.messagesFor(threadId), stored]);
    return stored;
  }

  patchMessage(threadId: string, messageId: string, patch: { card: OptionCardLike }): StoredMessage | null {
    const message = this.messagesFor(threadId).find((candidate) => candidate.id === messageId);
    if (!message) return null;
    message.card = structuredClone(patch.card);
    return message;
  }
}

const CATALOG: SettingCatalogInstance[] = [
  {
    instanceId: "claude",
    displayName: "Claude",
    models: {
      default: "claude-sonnet-5-5",
      options: [
        { id: "claude-sonnet-5-5", label: "Sonnet 5.5" },
        { id: "claude-haiku-5-5", label: "Haiku 5.5" },
        { id: "claude-opus-5-5", label: "Opus 5.5" },
      ],
    },
  },
  {
    instanceId: "codex",
    displayName: "Codex",
    models: { default: "gpt-6", options: [{ id: "gpt-6", label: "GPT-6" }, { id: "gpt-6-mini", label: "GPT-6 mini" }] },
  },
];

/** What PATCH /api/bots/:id does with the fields begin() hands it, reduced to
 * the setting fields under test. */
function applyRoutePatch(bot: BotRecord, body: Record<string, unknown>) {
  if (body.modelSelection) bot.modelSelection = body.modelSelection as BotRecord["modelSelection"];
  if ("computer" in body) bot.computer = (body.computer ?? undefined) as BotRecord["computer"];
  for (const key of ["notifications", "pinned", "composio", "browser", "speakReplies"] as const) {
    if (body[key] !== undefined) (bot as unknown as Record<string, unknown>)[key] = body[key];
  }
}

function harness(options: { enabled?: boolean } = {}) {
  const store = new MemoryStore();
  let enabled = options.enabled ?? true;
  function addBot(name: string, extra: Partial<BotRecord> = {}): BotRecord {
    const record = {
      id: randomUUID(),
      threadId: randomUUID(),
      name,
      title: "",
      description: "",
      soul: "",
      notifications: true,
      color: "blue",
      unread: false,
      modelSelection: { instanceId: "claude", model: "claude-sonnet-5-5", effort: "high" },
      resumeCursors: {},
      ...extra,
    } as unknown as BotRecord;
    store.bots.set(record.id, record);
    return record;
  }
  const service = new SettingChangeService({
    store,
    enabled: () => enabled,
    catalog: () => CATALOG,
    // propose_profile's rule, verbatim in shape: Chief + reachable peer.
    validateTarget: (proposerBotId, targetBotId) => {
      const proposer = store.bot(proposerBotId);
      const target = store.bot(targetBotId);
      if (!target) return "that bot no longer exists";
      if (!proposer?.chiefOfStaff) return "only a section's Chief of Staff can change another bot's profile";
      if ((proposer.section ?? "") !== (target.section ?? "")) return "that bot is not in a team this Chief is allowed to manage";
      return null;
    },
  });
  return { store, service, addBot, setEnabled: (on: boolean) => { enabled = on; } };
}

function act(service: SettingChangeService, bot: BotRecord, threadId: string, requestId: string, action: "apply" | "undo" | "decline") {
  const body: Record<string, unknown> = { settingChange: { threadId, requestId, action } };
  const step = service.begin(bot.id, body);
  if (step.kind === "patch") {
    applyRoutePatch(bot, body);
    service.commit(step.ticket);
  }
  return { step, body };
}

function expectRefusal(fn: () => unknown, status: number, text?: string | RegExp) {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(SettingChangeError);
  expect((caught as SettingChangeError).status).toBe(status);
  if (text) expect((caught as Error).message).toMatch(text);
}

describe("SettingChangeService", () => {
  it("posts a card for a model change and never changes the bot", () => {
    const { store, service, addBot } = harness();
    const cash = addBot("cash");
    const proposed = service.propose({ botId: cash.id, threadId: cash.threadId, setting: "model", value: "haiku" });
    expect(proposed.state).toBe("pending");
    expect(proposed.summary).toBe("cash: model Sonnet 5.5 → Haiku 5.5");
    expect(cash.modelSelection.model).toBe("claude-sonnet-5-5");
    const card = store.messagesFor(cash.threadId)[0]!.card!;
    expect(card).toMatchObject({ options: [], dismissed: true, tool: "change_setting", requestId: proposed.requestId });
    expect(card.answered).toBeUndefined();
    expect(card.settingChange).toMatchObject({
      version: 1,
      botId: cash.id,
      targetBotId: cash.id,
      targetName: "cash",
      setting: "model",
      before: { instanceId: "claude", model: "claude-sonnet-5-5", effort: "high" },
      // effort belongs to the engine, so it carries over within one
      after: { instanceId: "claude", model: "claude-haiku-5-5", effort: "high" },
      settingLabel: "model",
      beforeLabel: "Sonnet 5.5",
      afterLabel: "Haiku 5.5",
    });
  });

  it("applies through the route's fields, then undo restores the previous value", () => {
    const { store, service, addBot } = harness();
    const cash = addBot("cash");
    const { requestId } = service.propose({ botId: cash.id, threadId: cash.threadId, setting: "model", value: "claude-haiku-5-5" });

    const applied = act(service, cash, cash.threadId, requestId, "apply");
    // apply hands PATCH /api/bots/:id the same fields the settings UI sends,
    // with the strict "must be an offered model" check
    expect(applied.body).toEqual({ modelSelection: { instanceId: "claude", model: "claude-haiku-5-5", effort: "high" }, requireAvailableModel: true });
    expect(cash.modelSelection).toEqual({ instanceId: "claude", model: "claude-haiku-5-5", effort: "high" });
    const afterApply = store.messagesFor(cash.threadId)[0]!.card!;
    expect(afterApply.answered).toBe("allow");
    expect(afterApply.settingChange?.appliedAt).toEqual(expect.any(Number));

    const undone = act(service, cash, cash.threadId, requestId, "undo");
    expect(undone.body).toEqual({ modelSelection: { instanceId: "claude", model: "claude-sonnet-5-5", effort: "high" } });
    expect(cash.modelSelection).toEqual({ instanceId: "claude", model: "claude-sonnet-5-5", effort: "high" });
    expect(store.messagesFor(cash.threadId)[0]!.card!.settingChange?.undoneAt).toEqual(expect.any(Number));
    expectRefusal(() => act(service, cash, cash.threadId, requestId, "undo"), 409, /already undone/);
    expectRefusal(() => act(service, cash, cash.threadId, requestId, "apply"), 409, /already applied/);
  });

  it.each([
    ["notifications", "off", { notifications: false }, { notifications: true }],
    ["pinned", "on", { pinned: true }, { pinned: false }],
    ["computer", "boxcompute", { computer: "boxcompute" }, { computer: null }],
    ["apps", "off", { composio: false }, { composio: true }],
    ["browser", "off", { browser: false }, { browser: true }],
    ["speak_replies", "on", { speakReplies: true }, { speakReplies: false }],
  ])("maps %s to the settings UI's own patch fields", (setting, value, applyBody, undoBody) => {
    const { service, addBot } = harness();
    const oracle = addBot("oracle");
    const { requestId } = service.propose({ botId: oracle.id, threadId: oracle.threadId, setting, value });
    expect(act(service, oracle, oracle.threadId, requestId, "apply").body).toEqual(applyBody);
    expect(act(service, oracle, oracle.threadId, requestId, "undo").body).toEqual(undoBody);
  });

  it("refuses a stale card instead of clobbering a newer change", () => {
    const { store, service, addBot } = harness();
    const cash = addBot("cash");
    const { requestId } = service.propose({ botId: cash.id, threadId: cash.threadId, setting: "model", value: "Haiku 5.5" });
    // the person picked Opus in settings after the card was posted
    cash.modelSelection = { instanceId: "claude", model: "claude-opus-5-5" };
    expectRefusal(() => act(service, cash, cash.threadId, requestId, "apply"), 409, /changed after the card was prepared/);
    expect(cash.modelSelection.model).toBe("claude-opus-5-5");
    expect(store.messagesFor(cash.threadId)[0]!.card!.settingChange?.appliedAt).toBeUndefined();
  });

  it("undo restores only while the value is still what the card set", () => {
    const { service, addBot } = harness();
    const oracle = addBot("oracle");
    const { requestId } = service.propose({ botId: oracle.id, threadId: oracle.threadId, setting: "notifications", value: "off" });
    act(service, oracle, oracle.threadId, requestId, "apply");
    expect(oracle.notifications).toBe(false);
    oracle.notifications = true; // changed again elsewhere
    expectRefusal(() => act(service, oracle, oracle.threadId, requestId, "undo"), 409, /changed again/);
    expect(oracle.notifications).toBe(true);
    expect(settingRevision(true)).not.toBe(settingRevision(false));
  });

  it("refuses a non-chief targeting a peer, and lets a chief target its section", () => {
    const { store, service, addBot } = harness();
    const cash = addBot("cash", { section: "ops" });
    const oracle = addBot("oracle", { section: "ops" });
    expectRefusal(
      () => service.propose({ botId: cash.id, threadId: cash.threadId, targetBotId: oracle.id, setting: "pinned", value: "on" }),
      403,
      /Chief of Staff/,
    );
    expect(store.messagesFor(cash.threadId)).toHaveLength(0);

    const chief = addBot("bos", { section: "ops", chiefOfStaff: true });
    const outsider = addBot("far", { section: "sales" });
    expectRefusal(
      () => service.propose({ botId: chief.id, threadId: chief.threadId, targetBotId: outsider.id, setting: "pinned", value: "on" }),
      403,
      /not in a team/,
    );
    const ok = service.propose({ botId: chief.id, threadId: chief.threadId, targetBotId: oracle.id, setting: "notifications", value: "off" });
    expect(ok.summary).toBe("oracle: notifications on → muted");

    // authority is re-checked when the person taps Apply
    chief.chiefOfStaff = false;
    expectRefusal(() => act(service, oracle, chief.threadId, ok.requestId, "apply"), 403, /Chief of Staff/);
    expect(oracle.notifications).toBe(true);
  });

  it("refuses an unknown model and lists real choices instead of inventing one", () => {
    const { store, service, addBot } = harness();
    const cash = addBot("cash");
    expectRefusal(
      () => service.propose({ botId: cash.id, threadId: cash.threadId, setting: "model", value: "gemini-9-ultra" }),
      400,
      /no available model matches "gemini-9-ultra".*Haiku 5\.5 \(claude-haiku-5-5 on claude\)/,
    );
    expectRefusal(
      () => service.propose({ botId: cash.id, threadId: cash.threadId, setting: "model", value: "claude-haiku-5-5", instanceId: "nope" }),
      400,
      /no available engine/,
    );
    expect(store.messagesFor(cash.threadId)).toHaveLength(0);
  });

  it("asks for the exact id when a name matches several models", () => {
    const { service, addBot } = harness();
    const cash = addBot("cash", { modelSelection: { instanceId: "other", model: "x" } });
    expectRefusal(() => service.propose({ botId: cash.id, threadId: cash.threadId, setting: "model", value: "5.5" }), 400, /matches several models/);
    const moved = service.propose({ botId: cash.id, threadId: cash.threadId, setting: "model", value: "GPT-6 mini" });
    expect(moved.summary).toBe("cash: model x (other) → GPT-6 mini (Codex)");
  });

  it("refuses a model the catalog stopped offering at apply time", () => {
    const { service, store, addBot } = harness();
    const cash = addBot("cash");
    const { requestId } = service.propose({ botId: cash.id, threadId: cash.threadId, setting: "model", value: "Opus 5.5" });
    const options = CATALOG[0]!.models.options;
    const removed = options.splice(2, 1);
    try {
      expectRefusal(() => act(service, cash, cash.threadId, requestId, "apply"), 400, /no longer offered/);
    } finally {
      options.push(...removed);
    }
    expect(store.messagesFor(cash.threadId)[0]!.card!.settingChange?.appliedAt).toBeUndefined();
  });

  it("refuses a no-op, bad values, and combining a card with other fields", () => {
    const { service, addBot } = harness();
    const cash = addBot("cash");
    expectRefusal(() => service.propose({ botId: cash.id, threadId: cash.threadId, setting: "pinned", value: "off" }), 409, /already not pinned/);
    expectRefusal(() => service.propose({ botId: cash.id, threadId: cash.threadId, setting: "volume", value: "on" }), 400);
    expectRefusal(() => service.propose({ botId: cash.id, threadId: cash.threadId, setting: "computer", value: "mars" }), 400);
    const { requestId } = service.propose({ botId: cash.id, threadId: cash.threadId, setting: "pinned", value: "on" });
    expectRefusal(() => service.begin(cash.id, { settingChange: { threadId: cash.threadId, requestId, action: "apply" }, name: "x" }), 400, /cannot be combined/);
    const other = addBot("other");
    expectRefusal(() => service.begin(other.id, { settingChange: { threadId: cash.threadId, requestId, action: "apply" } }), 400, /different bot/);
  });

  it("Not now settles the card without touching the bot", () => {
    const { store, service, addBot } = harness();
    const cash = addBot("cash");
    const { requestId } = service.propose({ botId: cash.id, threadId: cash.threadId, setting: "browser", value: "off" });
    const { step } = act(service, cash, cash.threadId, requestId, "decline");
    expect(step.kind).toBe("settled");
    expect(cash.browser).toBeUndefined();
    const card = store.messagesFor(cash.threadId)[0]!.card!;
    expect(card.answered).toBe("deny");
    expect(card.settingChange?.declinedAt).toEqual(expect.any(Number));
    expectRefusal(() => act(service, cash, cash.threadId, requestId, "apply"), 409, /dismissed/);
  });

  it("does nothing while the server switch is off", () => {
    const { store, service, addBot, setEnabled } = harness({ enabled: false });
    const cash = addBot("cash");
    expectRefusal(() => service.propose({ botId: cash.id, threadId: cash.threadId, setting: "pinned", value: "on" }), 403, /turned off/);
    expect(store.messagesFor(cash.threadId)).toHaveLength(0);
    setEnabled(true);
    const { requestId } = service.propose({ botId: cash.id, threadId: cash.threadId, setting: "pinned", value: "on" });
    setEnabled(false);
    expectRefusal(() => act(service, cash, cash.threadId, requestId, "apply"), 403, /turned off/);
    expect(cash.pinned).toBeUndefined();
  });

  it("caps open cards per thread", () => {
    const { service, addBot } = harness();
    const cash = addBot("cash");
    for (let index = 0; index < 8; index++) {
      service.propose({ botId: cash.id, threadId: cash.threadId, setting: "pinned", value: "on" });
    }
    expectRefusal(() => service.propose({ botId: cash.id, threadId: cash.threadId, setting: "pinned", value: "on" }), 429);
  });
});
