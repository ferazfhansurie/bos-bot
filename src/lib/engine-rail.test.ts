import { describe, expect, it } from "vitest";

import { splitEngineRail } from "./engine-rail";

describe("splitEngineRail", () => {
  it("keeps Cloud engines above Local engines", () => {
    const { subscription, custom } = splitEngineRail([
      { access: "subscription", instanceId: "claude" },
      { access: "custom", instanceId: "hermes" },
      { instanceId: "grok" },
      { access: "custom", instanceId: "qwen" },
    ]);
    expect(subscription.map((row) => row.instanceId)).toEqual(["claude", "grok"]);
    expect(custom.map((row) => row.instanceId)).toEqual(["hermes", "qwen"]);
  });

  it("hides the second group when nothing is custom-only", () => {
    const rows = [{ instanceId: "claude" }];
    expect(splitEngineRail(rows).custom).toEqual([]);
  });
});

it('places free cloud catalogs in Cloud despite custom connection metadata',()=>{
 const free={instanceId:'bos-free',driverKind:'openrouter-free',access:'custom'};
 const local={instanceId:'local',driverKind:'hermesAgent',access:'custom'};
 expect(splitEngineRail([free,local])).toEqual({subscription:[free],custom:[local]});
});
