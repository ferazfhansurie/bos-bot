export const BOS_PRODUCT = Object.freeze({
  name: "BOS Bot",
  appId: "ai.bos.bot",
  protocol: "bosbot",
  supportedProviders: ["claude", "codex"] as const,
  localOnly: true,
  features: Object.freeze({
    hostedWorkspace: false,
    companion: false,
    phone: false,
    box: false,
    composio: false,
    routines: false,
    webhooks: false,
    telemetry: false,
    localComputerControl: "opt-in" as const,
  }),
});

export type BosProvider = (typeof BOS_PRODUCT.supportedProviders)[number];

export function isBosProvider(value: string): value is BosProvider {
  return BOS_PRODUCT.supportedProviders.some((provider) => provider === value);
}
