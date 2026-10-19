import { describe, expect, it } from "vitest";
import type { InstanceInfo } from "@/state/store";
import { botReadinessRows } from "./bot-readiness";

const engine: InstanceInfo = {
  instanceId: "test", driverKind: "codex", displayName: "test account",
  snapshot: { state: "available", authenticated: true },
  capabilities: { composioMcp: true }, models: { default: "test", options: [] },
};
const input = { instanceId: "test", instances: [engine], appsEnabled: true, connections: { configured: true, authoritative: true, services: ["gmail"], pending: ["slack"], reconnect: ["calendar"] } };

describe("bot readiness", () => {
  it("distinguishes usable, pending and expired connections and the next fix", () => {
    const rows = botReadinessRows(input);
    expect(rows.find(row => row.id === "app:gmail")).toMatchObject({ state: "ok", detail: "connected" });
    expect(rows.find(row => row.id === "app:slack")).toMatchObject({ state: "waiting", action: "apps" });
    expect(rows.find(row => row.id === "app:calendar")).toMatchObject({ state: "action", actionLabel: "reconnect" });
    expect(botReadinessRows({ ...input, connections: { ...input.connections, services: ["gmail", "slack"], pending: [] } }).find(row => row.id === "app:slack")?.state).toBe("ok");
  });
  it("never preserves green rows when a connection refresh fails", () => {
    expect(botReadinessRows({ ...input, connections: { ...input.connections, authoritative: false } })).toEqual([
      expect.objectContaining({ id: "model", state: "ok" }),
      expect.objectContaining({ id: "apps", state: "unknown" }),
    ]);
    expect(botReadinessRows({ ...input, instances: undefined })[0]).toMatchObject({ state: "unknown" });
  });
  it("does not treat optional tools as mandatory or enable them", () => {
    expect(botReadinessRows({ ...input, appsEnabled: false })[1]).toMatchObject({ state: "optional", action: "access" });
    expect(botReadinessRows({ ...input, connections: { configured: false, authoritative: true, services: [] } })[1]).toMatchObject({ state: "optional", actionLabel: "connect apps" });
  });
  it("points missing accounts to model choice, and signed-out accounts to sign-in", () => {
    expect(botReadinessRows({ ...input, instances: [] })[0]).toMatchObject({ state: "action", action: "model" });
    expect(botReadinessRows({ ...input, instances: [{ ...engine, snapshot: { state: "available", authenticated: false } }] })[0]).toMatchObject({ state: "action", actionLabel: "sign in" });
  });
  it("does not promise connected-app access for an unsupported or unknown engine", () => {
    expect(botReadinessRows({ ...input, instances: [{ ...engine, capabilities: { composioMcp: false } }] })[1]).toMatchObject({ state: "optional", action: "model" });
    expect(botReadinessRows({ ...input, instances: [] }).find(row => row.id === "app:gmail")?.state).toBe("unknown");
  });
});

it("checks only declared template requirements and keeps optional apps optional", () => {
  const rows = botReadinessRows({ ...input, requirements: {
    id: "template", name: "Template", release: "1.0.0",
    requiredApps: [
      { slug: "gmail", label: "Gmail", reason: "Read mail." },
      { slug: "github", label: "GitHub", reason: "Optional code.", optional: true },
      { slug: "notion", label: "Notion", reason: "Read notes." },
    ],
    requiredTools: [{ slug: "reports", kind: "plugin", label: "Reports", reason: "Write reports." }],
  } });
  expect(rows.find(row => row.id === "app:gmail")?.state).toBe("ok");
  expect(rows.find(row => row.id === "app:github")).toMatchObject({ state: "optional", action: "apps" });
  expect(rows.find(row => row.id === "app:notion")).toMatchObject({ state: "action", action: "apps" });
  expect(rows.find(row => row.id === "app:calendar")).toBeUndefined();
  expect(rows.find(row => row.id === "tool:plugin:reports")).toMatchObject({ state: "unknown", action: "plugins" });
});
