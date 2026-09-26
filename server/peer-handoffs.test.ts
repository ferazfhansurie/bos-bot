import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { PeerHandoffs } from "./peer-handoffs.ts";

it("keeps a lost-response handoff retryable across restart until the new token is used", () => {
  const dir = mkdtempSync(join(tmpdir(), "bos-peer-handoff-"));
  try {
    const file = join(dir, "handoffs.json");
    const first = new PeerHandoffs(file);
    expect(first.prepare("old-session", "lost-session")).toBeNull();
    const resumed = new PeerHandoffs(file);
    expect(resumed.prepare("old-session", "new-session")).toBe("lost-session");
    expect(resumed.confirm("lost-session")).toBeNull();
    expect(resumed.confirm("new-session")).toBe("old-session");
    expect(new PeerHandoffs(file).confirm("new-session")).toBeNull();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
