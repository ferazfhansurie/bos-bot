import { expect, it } from "vitest";
import { selectTailnetOrigin } from "./tailnet-origin.ts";

it("selects only a Running client on the peer tailnet", () => {
  const statuses = [
    { BackendState: "Stopped", Self: { DNSName: "wrong.team-a.ts.net." } },
    { BackendState: "Running", Self: { DNSName: "firaz.team-b.ts.net." } },
    { BackendState: "Running", Self: { DNSName: "firaz.team-a.ts.net." } },
  ];
  expect(selectTailnetOrigin(statuses, "https://putri.team-a.ts.net")).toBe("https://firaz.team-a.ts.net:8443");
  expect(selectTailnetOrigin(statuses, "https://putri.team-c.ts.net")).toBeNull();
});
