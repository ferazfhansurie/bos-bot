import type { BotOverview } from "./bot-overview-types";
import type { InstanceInfo } from "@/state/store";

export type ReadinessAction = "model" | "engines" | "apps" | "access" | "channels" | "plugins";
export interface ReadinessRow {
  id: string;
  label: string;
  state: "ok" | "action" | "waiting" | "optional" | "unknown";
  detail: string;
  action?: ReadinessAction;
  actionLabel?: string;
}

/** Configuration evidence only; never claims that an actual task succeeded. */
export function botReadinessRows(input: {
  instanceId: string;
  instances?: InstanceInfo[];
  appsEnabled: boolean;
  connections?: BotOverview["connections"];
  requirements?: BotOverview["requirements"];
  toolAvailability?: BotOverview["toolAvailability"];
}): ReadinessRow[] {
  const rows: ReadinessRow[] = [];
  const engine = input.instances?.find(instance => instance.instanceId === input.instanceId);
  if (!input.instances) {
    rows.push({ id: "model", label: "model account", state: "unknown", detail: "could not check the model account. check again.", action: "engines", actionLabel: "open model accounts" });
  } else if (!engine) {
    rows.push({ id: "model", label: "model account", state: "action", detail: "the selected model account is no longer available.", action: "model", actionLabel: "choose a model" });
  } else if (engine.snapshot.authenticated === false && engine.access !== "custom") {
    rows.push({ id: "model", label: engine.displayName, state: "action", detail: "sign in to use this model account.", action: "engines", actionLabel: "sign in" });
  } else if (engine.snapshot.state !== "available") {
    rows.push({ id: "model", label: engine.displayName, state: "action", detail: "this model account is unavailable. open its settings to check installation and connection.", action: "engines", actionLabel: "check model account" });
  } else {
    rows.push({ id: "model", label: engine.displayName, state: "ok", detail: "available for chats" });
  }

  if (input.requirements) {
    for (const app of input.requirements.requiredApps) {
      const inventory = input.connections;
      const normalize = (value: string) => value.toLowerCase().replace(/[\s_-]/g, "");
      const names = (values: string[] = []) => values.map(normalize);
      const aliases = [normalize(app.slug), normalize(app.label)];
      const matches = (values?: string[]) => aliases.some(alias => names(values).includes(alias));
      const base = { id: `app:${app.slug}`, label: app.label, detail: app.reason };
      const optional = app.optional === true;
      if (!input.appsEnabled) rows.push({ ...base, state: optional ? "optional" : "action", detail: `${app.reason} app access is switched off for this bot.`, action: "access", actionLabel: "enable app access" });
      else if (engine?.capabilities?.composioMcp === false) rows.push({ ...base, state: optional ? "optional" : "action", detail: `${app.reason} this model cannot use connected apps.`, action: "model", actionLabel: "choose a model" });
      else if (!inventory?.authoritative) rows.push({ ...base, state: "unknown", detail: `${app.reason} connection could not be verified.`, action: "apps", actionLabel: "check connection" });
      else if (matches(inventory.services)) rows.push({ ...base, state: engine?.capabilities?.composioMcp === true ? "ok" : "unknown", detail: engine?.capabilities?.composioMcp === true ? `${app.reason} connected.` : `${app.reason} connected; model access could not be verified.` });
      else if (matches(inventory.pending)) rows.push({ ...base, state: "waiting", detail: `${app.reason} finish connecting your account.`, action: "apps", actionLabel: "continue connecting" });
      else rows.push({ ...base, state: optional ? "optional" : "action", detail: `${app.reason} ${optional ? "optional account" : "your account"} needs connecting.`, action: "apps", actionLabel: matches(inventory.reconnect) ? "reconnect" : "connect account" });
    }
    for (const tool of input.requirements.requiredTools ?? []) {
      const available = tool.kind === "plugin" ? undefined : input.toolAvailability?.[tool.kind];
      rows.push({ id: `tool:${tool.kind}:${tool.slug}`, label: tool.label,
        state: available ? "ok" : tool.optional ? "optional" : available === false ? "action" : "unknown",
        detail: `${tool.reason} ${available ? "available for this bot." : tool.kind === "plugin" ? "review this plugin and its setup in plugins." : "check tool access and the selected model."}`,
        ...(available ? {} : { action: tool.kind === "plugin" ? "plugins" as const : "access" as const, actionLabel: tool.kind === "plugin" ? "open plugins" : "manage tool access" }),
      });
    }
    for (const capability of input.requirements.requiredCapabilities ?? []) {
      rows.push({ id: `capability:${capability}`, label: capability, state: "unknown", detail: "this template needs this capability. review its setup before relying on it.", action: "plugins", actionLabel: "review tools" });
    }
    if (!input.requirements.requiredApps.length && !input.requirements.requiredTools?.length && !input.requirements.requiredCapabilities?.length) {
      rows.push({ id: "apps", label: "connected apps", state: "optional", detail: "this template does not require connected apps." });
    }
    return rows;
  }

  if (!input.appsEnabled) {
    rows.push({ id: "apps", label: "connected apps", state: "optional", detail: "switched off for this bot", action: "access", actionLabel: "manage access" });
  } else if (engine?.capabilities?.composioMcp === false) {
    rows.push({ id: "apps", label: "connected apps", state: "optional", detail: "this model does not support connected apps", action: "model", actionLabel: "choose a model" });
  } else if (!input.connections || !input.connections.authoritative) {
    rows.push({ id: "apps", label: "connected apps", state: "unknown", detail: "could not verify app connections. check again before relying on them.", action: "apps", actionLabel: "check connections" });
  } else if (!input.connections.configured) {
    rows.push({ id: "apps", label: "connected apps", state: "optional", detail: "connect apps when this bot needs them. chatting does not require them.", action: "apps", actionLabel: "connect apps" });
  } else {
    const { services, pending = [], reconnect = [] } = input.connections;
    if (!services.length && !pending.length && !reconnect.length) {
      rows.push({ id: "apps", label: "connected apps", state: "optional", detail: "no apps connected yet", action: "apps", actionLabel: "connect an app" });
    }
    for (const name of [...new Set([...services, ...pending, ...reconnect])].sort()) {
      const canUse = engine?.capabilities?.composioMcp === true;
      rows.push(services.includes(name)
        ? { id: `app:${name}`, label: name, state: canUse ? "ok" : "unknown", detail: canUse ? "connected" : "connected; this model's app access could not be verified", ...(canUse ? {} : { action: "model" as const, actionLabel: "check model" }) }
        : pending.includes(name)
          ? { id: `app:${name}`, label: name, state: "waiting", detail: "waiting for you to finish connecting. this updates automatically.", action: "apps", actionLabel: "continue connecting" }
          : { id: `app:${name}`, label: name, state: "action", detail: "connection needs attention. reconnect to use this app.", action: "apps", actionLabel: "reconnect" });
    }
  }
  return rows;
}
