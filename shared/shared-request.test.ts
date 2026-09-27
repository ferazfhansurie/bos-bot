import { expect, it } from "vitest";
import { sharedRequestProgress } from "./shared-request.ts";

it("keeps provider commands, paths and approval arguments out of shared progress", () => {
  const secret = "private-token /Users/owner/private.txt";
  for (const ok of [undefined, true, false]) {
    const progress = sharedRequestProgress({ name: `shell ${secret}`, spoken: secret, ok }, "Helper", "Alex");
    expect(progress.name).toBe("step");
    expect(progress.ok).toBe(ok);
    expect(JSON.stringify(progress)).not.toContain(secret);
  }
  expect(sharedRequestProgress({ name: "waiting for approval", spoken: secret }, "Helper", "Alex"))
    .toEqual({ name: "waiting for approval", spoken: "Waiting for Alex to approve on their Mac." });
  expect(sharedRequestProgress({ name: "working", ok: false, spoken: secret }, "Helper", "Alex"))
    .toEqual({ name: "working", ok: false, spoken: "Helper stopped working." });
});
