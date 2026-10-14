import { expect, it } from "vitest";
import { accountBotNames, accountRings } from "./account-usage";
import type { UsageAccount } from "./usage-chips";

const personal: UsageAccount = { provider: "claude", instanceId: "personal", account: "personal", fiveHour: { usedPercent: 8, resetsAt: null }, sevenDay: { usedPercent: 20, resetsAt: null }, status: "available" };
const work: UsageAccount = { ...personal, instanceId: "work", account: "work", sevenDay: { usedPercent: 90, resetsAt: null } };

it("keeps two subscriptions independent and stable across response ordering", () => {
  const rings = accountRings([work, personal]);
  expect(rings.map(r => [r.label, r.peak])).toEqual([["personal · Claude", 20], ["work · Claude", 90]]);
  expect(rings[0].color).not.toBe(rings[1].color);
  expect(accountRings([personal, work])).toEqual(rings);
  expect(rings.every(r => r.radius - 1.25 > 14)).toBe(true);
});

it("preserves unavailable accounts without pretending they have zero usage", () => {
  expect(accountRings([{ ...personal, fiveHour: undefined, sevenDay: { usedPercent: null, resetsAt: null } }])[0].peak).toBeNull();
  expect(accountRings([])).toEqual([]);
});

it("matches bot defaults by identity rather than display name", () => {
  const bots = [{ name: "bos", modelSelection: { instanceId: "personal" } }, { name: "money", modelSelection: { instanceId: "personal" } }, { name: "oracle", modelSelection: { instanceId: "work" } }];
  expect(accountBotNames("personal", bots)).toEqual(["bos", "money"]);
  expect(accountBotNames("work", bots)).toEqual(["oracle"]);
  expect(accountBotNames(undefined, bots)).toEqual([]);
  expect(accountBotNames("personal", [...bots, { name: "Remote bot", homeLink: { id: "another-server" }, modelSelection: { instanceId: "personal" } }])).toEqual(["bos", "money"]);
  expect(accountBotNames("personal", [...bots, { name: "Shared client bot", remote: { id: "another-server" }, modelSelection: { instanceId: "personal" } }])).toEqual(["bos", "money"]);
});

it("gives every account its own skin hue, even when several are nearly spent", () => {
  const codex: UsageAccount = { ...personal, provider: "codex", instanceId: "codex", account: "codex", sevenDay: { usedPercent: 99, resetsAt: null } };
  const rings = accountRings([codex, work, { ...personal, sevenDay: { usedPercent: 95, resetsAt: null } }]);
  expect(rings.map(r => r.color)).toEqual(["var(--color-usage-1)", "var(--color-usage-2)", "var(--color-usage-3)"]);
});
