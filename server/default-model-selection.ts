import type { EffortLevel, ModelCatalog, ModelSelection, ProviderSnapshot } from "./contracts.ts";

interface SelectableInstance {
  instanceId: string;
  driverKind: string;
  snapshot: ProviderSnapshot;
  models: ModelCatalog;
  capabilities?: { effortLevels?: readonly EffortLevel[]; modelVariants?: boolean };
}

/** A saved choice is intentional: an unavailable provider or removed model
 * sends new bots to setup instead of silently changing their provider. */
export function selectDefaultModelSelection(
  instances: readonly SelectableInstance[],
  preferred?: ModelSelection,
): ModelSelection {
  if (preferred) {
    const instance = instances.find((candidate) => candidate.instanceId === preferred.instanceId);
    if (
      instance?.snapshot.state !== "available" ||
      instance.snapshot.authenticated === false ||
      (preferred.variant !== undefined && !instance.capabilities?.modelVariants) ||
      !(instance.models.default === preferred.model || instance.models.options.some((model) => model.id === preferred.model))
    ) {
      return { instanceId: "", model: "" };
    }
    const selection = { ...preferred };
    // A saved effort can outlive driver support. Keep the intentional model,
    // but let the provider use its own effort default instead of failing turn 1.
    if (selection.effort && !instance.capabilities?.effortLevels?.includes(selection.effort)) delete selection.effort;
    return selection;
  }
  const installed = instances.filter((instance) => instance.snapshot.state === "available");
  // A signed-in engine beats an installed-but-signed-out one; turn 1 on a
  // signed-out CLI fails with raw provider output.
  const ready = installed.filter((instance) => instance.snapshot.authenticated !== false);
  const available = ready.length ? ready : installed;
  const pick = available.find((instance) => instance.driverKind === "claudeAgent") ?? available[0];
  return { instanceId: pick?.instanceId ?? "", model: pick?.models.default ?? "" };
}

/** True when a saved selection can start a turn right now. */
export function selectionUsable(instances: readonly SelectableInstance[], selection: ModelSelection | undefined): boolean {
  if (!selection?.instanceId) return false;
  const instance = instances.find((candidate) => candidate.instanceId === selection.instanceId);
  return instance?.snapshot.state === "available" && instance.snapshot.authenticated !== false;
}

/** The selection BOS Free setup offers bots whose engine cannot run. */
export function freeFallbackSelection(instances: readonly SelectableInstance[], instanceId: string): ModelSelection | null {
  const instance = instances.find((candidate) => candidate.instanceId === instanceId);
  if (!instance || !selectionUsable(instances, { instanceId, model: instance.models.default })) return null;
  return { instanceId, model: instance.models.default };
}
