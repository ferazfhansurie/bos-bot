import { rmSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { Store, toWireTask } from "./store.ts";
import { ModelFallbackService, isModelUnavailable, isProviderLimit, fallbackSelection, unavailableModelIn } from "./model-fallback.ts";
import type { ProviderInstance, RuntimeEvent } from "./contracts.ts";
import type { ProviderUsage } from "./provider-usage.ts";

const primary = { instanceId: "primary", model: "primary-model", effort: "high" as const };
const backup = { instanceId: "backup", model: "backup-model" };
beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));
function fixture() {
  const store = new Store(() => primary);
  const bot = store.createBot({}, { seedMessages: false });
  store.patchBot(bot.id, { fallbackModel: backup.model });
  let now = 100_000;
  let rows: ProviderUsage[] = [{ provider: "claude", instanceId: "primary", account: "primary", status: "available", sevenDay: { usedPercent: 100, resetsAt: 110 } }];
  const instances = [
    { instanceId: "primary", driverKind: "claudeAgent", models: { default: primary.model, options: [] }, snapshot: async () => ({ state: "available" }) },
    { instanceId: "backup", driverKind: "codex", models: { default: backup.model, options: [] }, snapshot: async () => ({ state: "available" }) },
  ] as unknown as ProviderInstance[];
  const events: RuntimeEvent[] = [];
  let keep = false;
  const service = new ModelFallbackService({ store, instances: () => instances, usage: async () => rows,
    keepPermissions: () => keep, now: () => now, publish: event => events.push(event), changing: () => false });
  return { store, bot, service, instances, events, rows: (next: ProviderUsage[]) => { rows = next; }, now: (next: number) => { now = next; }, keep: () => { keep = true; } };
}

it("switches the effective thread only at an exhausted window and restores at its reset", async () => {
  const f = fixture();
  expect(await f.service.beforeTurn(f.bot.id, f.bot.threadId)).toBe(true);
  expect(f.store.projectBotForTask(f.bot.id, f.bot.threadId)?.modelSelection).toEqual(backup);
  expect(f.bot.modelSelection).toEqual(primary);
  expect(toWireTask(f.store.taskByThread(f.bot.id, f.bot.threadId)!)).not.toHaveProperty("modelFallback");
  const reloaded = new Store(() => primary);
  expect(reloaded.taskByThread(f.bot.id, f.bot.threadId)?.modelFallback?.from).toEqual(primary);
  f.rows([{ provider: "claude", instanceId: "primary", account: "primary", status: "available", sevenDay: { usedPercent: 20, resetsAt: 210 } }]);
  expect(await f.service.restore()).toBe(0);
  f.now(110_000);
  expect(await f.service.restore()).toBe(1);
  expect(f.store.projectBotForTask(f.bot.id, f.bot.threadId)?.modelSelection).toEqual(primary);
  expect(f.events.map(e => e.type === "model.switched" ? e.reason : "")).toEqual(["provider_limit", "provider_reset"]);
});

it("recognizes quota and 429 but refuses auth, billing setup, safety and ordinary crashes", () => {
  for (const text of ["HTTP 429 too many requests", "You've hit your org's monthly spend limit", "usage limit reached", "quota exceeded"]) expect(isProviderLimit(text), text).toBe(true);
  for (const text of ["HTTP 401 unauthorized", "invalid API key: HTTP 429", "billing account missing", "subscription expired", "HTTP 503", "429 blocked by our safety systems", "interrupted"]) expect(isProviderLimit(text), text).toBe(false);
});

it("has one configured fallback attempt and never cascades to another model", async () => {
  const f = fixture();
  f.rows([]);
  expect(await f.service.afterFailure(f.bot.id, f.bot.threadId, "HTTP 429", false)).toBe(true);
  expect(await f.service.afterFailure(f.bot.id, f.bot.threadId, "HTTP 429", false)).toBe(false);
  expect(f.events).toHaveLength(1);
});

it("does not replay tool effects or fall back on authentication failures", async () => {
  const f = fixture();
  expect(await f.service.afterFailure(f.bot.id, f.bot.threadId, "HTTP 429", true)).toBe(false);
  expect(await f.service.afterFailure(f.bot.id, f.bot.threadId, "HTTP 401 unauthorized", false)).toBe(false);
  expect(f.events).toHaveLength(0);
});

it("keeps provider-bound grants fail closed and never widens permissions", async () => {
  const f = fixture();
  f.store.patchTask(f.bot.id, f.bot.threadId, { approvalMode: "full", autoApprove: true, alwaysAllow: ["fixture"] });
  expect(await f.service.beforeTurn(f.bot.id, f.bot.threadId)).toBe(false);
  f.keep();
  expect(await f.service.beforeTurn(f.bot.id, f.bot.threadId)).toBe(true);
  expect(f.store.projectBotForTask(f.bot.id, f.bot.threadId)).toMatchObject({ approvalMode: "full", autoApprove: true, alwaysAllow: ["fixture"] });
});

it("refuses pending grants, unsupported modes and unavailable or ambiguous backups", async () => {
  const f = fixture();
  f.store.patchBot(f.bot.id, { approvalGrant: { requestId: "grant", mode: "full", phase: "prepared" } });
  expect(await f.service.beforeTurn(f.bot.id, f.bot.threadId)).toBe(false);
  f.store.patchBot(f.bot.id, { approvalGrant: undefined });
  f.store.patchTask(f.bot.id, f.bot.threadId, { approvalMode: "edits" });
  f.keep();
  expect(await f.service.beforeTurn(f.bot.id, f.bot.threadId)).toBe(false);
  f.store.patchTask(f.bot.id, f.bot.threadId, { approvalMode: "ask" });
  f.instances.push({ ...f.instances[1], instanceId: "other" });
  expect(await f.service.beforeTurn(f.bot.id, f.bot.threadId)).toBe(false);
  f.instances.pop();
  f.instances[1].snapshot = async () => ({ state: "unavailable" });
  expect(await f.service.beforeTurn(f.bot.id, f.bot.threadId)).toBe(false);
});

it("never restores over a manual model change or while a thread is busy", async () => {
  const f = fixture();
  await f.service.beforeTurn(f.bot.id, f.bot.threadId);
  f.now(120_000);
  f.rows([{ provider: "claude", instanceId: "primary", account: "primary", status: "available", sevenDay: { usedPercent: 5, resetsAt: 210 } }]);
  f.store.setTaskActivity(f.bot.id, f.bot.threadId, "working");
  expect(await f.service.restore()).toBe(0);
  f.store.setTaskActivity(f.bot.id, f.bot.threadId, "idle");
  f.store.patchTask(f.bot.id, f.bot.threadId, { modelSelection: { ...backup, model: "manual" } });
  expect(await f.service.restore()).toBe(0);
  expect(f.store.taskByThread(f.bot.id, f.bot.threadId)?.modelFallback).toBeUndefined();
});

it("room preflight changes only that member's runtime selection and resets durably", async () => {
  const f = fixture();
  expect(await f.service.beforeRoomTurn(f.bot.id, "room-member", "ask")).toEqual(backup);
  expect(f.bot.modelSelection).toEqual(primary);
  expect(f.store.projectBotForTask(f.bot.id, f.bot.threadId)?.modelSelection).toEqual(primary);
  expect(new Store(() => primary).bot(f.bot.id)?.roomModelFallbacks?.["room-member"].from).toEqual(primary);
  f.now(120_000);
  f.rows([{ provider: "claude", instanceId: "primary", account: "primary", status: "available", sevenDay: { usedPercent: 20, resetsAt: 210 } }]);
  expect(await f.service.restore()).toBe(1);
  expect(f.bot.roomModelFallbacks?.["room-member"]).toBeUndefined();
  expect(await f.service.beforeRoomTurn(f.bot.id, "room-member", "ask")).toEqual(primary);
});

it("a deliberate selection of the same backup cancels automatic restore", async () => {
  const f = fixture();
  await f.service.beforeTurn(f.bot.id, f.bot.threadId);
  f.store.switchTaskModel(f.bot.id, f.bot.threadId, backup, false, false);
  expect(f.store.taskByThread(f.bot.id, f.bot.threadId)?.modelFallback).toBeUndefined();
});

it("unchanged stale below-limit telemetry and unknown resets do not restore a runtime fallback", async () => {
  const f = fixture();
  f.rows([{ provider: "claude", instanceId: "primary", account: "primary", status: "available", sevenDay: { usedPercent: 20, resetsAt: 210 } }]);
  expect(await f.service.afterFailure(f.bot.id, f.bot.threadId, "HTTP 429", false)).toBe(true);
  f.now(140_000);
  expect(await f.service.restore()).toBe(0);
  expect(f.store.projectBotForTask(f.bot.id, f.bot.threadId)?.modelSelection).toEqual(backup);
  f.rows([]);
  f.store.patchTask(f.bot.id, f.bot.threadId, { modelFallback: undefined, modelSelection: primary });
  expect(await f.service.afterFailure(f.bot.id, f.bot.threadId, "HTTP 429", false)).toBe(true);
  f.now(300_000);
  f.rows([{ provider: "claude", instanceId: "primary", account: "primary", status: "available", sevenDay: { usedPercent: 20, resetsAt: 410 } }]);
  expect(await f.service.restore()).toBe(0);
});

it("exhausted cached usage does not hide a signed-out primary provider", async () => {
  const f = fixture();
  f.instances[0].snapshot = async () => ({ state: "available", authenticated: false });
  expect(await f.service.beforeTurn(f.bot.id, f.bot.threadId)).toBe(false);
  expect(await f.service.beforeRoomTurn(f.bot.id, "room-member", "ask")).toEqual(primary);
  expect(f.events).toHaveLength(0);
});


it("never borrows a sibling Claude subscription for direct or room fallback", async () => {
  const f = fixture();
  f.instances[1] = { ...f.instances[1], driverKind: "claudeAgent" };
  expect(fallbackSelection(backup.model, f.instances, primary.instanceId)).toBeNull();
  expect(await f.service.beforeTurn(f.bot.id, f.bot.threadId)).toBe(false);
  expect(await f.service.afterFailure(f.bot.id, f.bot.threadId, "usage limit reached", false)).toBe(false);
  expect(await f.service.beforeRoomTurn(f.bot.id, "fixture-room", "ask")).toEqual(primary);
  expect(f.store.projectBotForTask(f.bot.id, f.bot.threadId)?.modelSelection).toEqual(primary);
  expect(f.events).toEqual([]);
  f.instances[0].models.options.push({ id: backup.model, label: "Same account backup" });
  expect(fallbackSelection(backup.model, f.instances, primary.instanceId)?.instanceId).toBe(primary.instanceId);
});

const refusal = "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.";
function codexFixture() {
  const sol = { instanceId: "codex", model: "gpt-6.1-sol", effort: "high" as const };
  const store = new Store(() => sol);
  const bot = store.createBot({}, { seedMessages: false });
  const other = store.createBot({}, { seedMessages: false });
  const claude = store.createBot({}, { seedMessages: false });
  store.patchBot(claude.id, { modelSelection: { instanceId: "claude", model: "gpt-6.1-sol" } });
  const instances = [
    { instanceId: "codex", driverKind: "codex", models: { default: "gpt-6-luna", options: [
      { id: "gpt-6.1-sol", label: "Sol" }, { id: "gpt-6-luna", label: "Luna" }, { id: "local::qwen", label: "Qwen", custom: true }] },
    snapshot: async () => ({ state: "available" }) },
  ] as unknown as ProviderInstance[];
  const events: RuntimeEvent[] = [];
  const service = new ModelFallbackService({ store, instances: () => instances, usage: async () => [],
    keepPermissions: () => false, publish: event => events.push(event), changing: () => false });
  return { store, bot, other, claude, sol, service, events, instances };
}

it("recognizes an account that cannot use a model, and nothing else", () => {
  for (const text of [refusal, "model not found", "The model `gpt-x` does not exist or you do not have access to the model"]) expect(isModelUnavailable(text), text).toBe(true);
  for (const text of ["HTTP 429 too many requests", "quota exceeded", "HTTP 401 unauthorized", "interrupted", ""]) expect(isModelUnavailable(text), text).toBe(false);
  expect(unavailableModelIn(refusal)).toBe("gpt-6.1-sol");
  expect(unavailableModelIn("model not found")).toBeNull();
});

it("moves every bot and thread pinned to a refused model onto the account default, once", () => {
  const f = codexFixture();
  const to = f.service.replaceUnavailable(f.bot.id, f.bot.threadId, f.sol, refusal);
  expect(to).toEqual({ instanceId: "codex", model: "gpt-6-luna", effort: "high" });
  expect(f.store.bot(f.bot.id)?.modelSelection.model).toBe("gpt-6-luna");
  expect(f.store.bot(f.other.id)?.modelSelection.model).toBe("gpt-6-luna");
  // another engine's bot with the same id is a different account
  expect(f.store.bot(f.claude.id)?.modelSelection.model).toBe("gpt-6.1-sol");
  expect(f.events.map(e => e.type === "model.switched" ? [e.from, e.to, e.reason] : [])).toEqual([["gpt-6.1-sol", "gpt-6-luna", "model_unavailable"]]);
  // codex repeats the refusal (error notification, then turn/completed)
  expect(f.service.replaceUnavailable(f.bot.id, f.bot.threadId, f.sol, refusal)?.model).toBe("gpt-6-luna");
  expect(f.events).toHaveLength(1);
});

it("switches a thread pinned to the refused model and skips refused or custom replacements", () => {
  const f = codexFixture();
  f.store.patchBot(f.bot.id, { modelSelection: { instanceId: "codex", model: "gpt-6-luna" } });
  f.store.patchTask(f.bot.id, f.bot.threadId, { modelSelection: f.sol });
  (f.instances[0].models as { default: string }).default = "gpt-6.1-sol";
  const to = f.service.replaceUnavailable(f.bot.id, f.bot.threadId, f.sol, refusal);
  expect(to?.model).toBe("gpt-6-luna");
  expect(f.store.projectBotForTask(f.bot.id, f.bot.threadId)?.modelSelection.model).toBe("gpt-6-luna");
  expect(f.service.refusedModels("codex").has("gpt-6.1-sol")).toBe(true);
});

it("leaves the selection alone when the account offers nothing else", () => {
  const f = codexFixture();
  (f.instances[0] as { models: unknown }).models = { default: "gpt-6.1-sol", options: [{ id: "gpt-6.1-sol", label: "Sol" }] };
  expect(f.service.replaceUnavailable(f.bot.id, f.bot.threadId, f.sol, refusal)).toBeNull();
  expect(f.store.bot(f.bot.id)?.modelSelection.model).toBe("gpt-6.1-sol");
  expect(f.events).toHaveLength(0);
});
