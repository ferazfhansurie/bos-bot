import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MultiplayerActors } from "./multiplayer-actors.ts";

describe("multiplayer actor bindings", () => {
  it("uses explicit per-device bindings and survives a restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-actors-"));
    try {
      const file = join(dir, "actors.json");
      const actors = new MultiplayerActors(file, "firaz-home");
      const putri = "putri-home:person:owner";
      expect(actors.ownerId).toBe("firaz-home:person:owner");
      expect(actors.actorFor("session-1")).toBeNull();
      actors.bind("owner-phone", actors.ownerId, "Firaz's iPhone");
      expect(actors.actorFor("owner-phone")).toBe(actors.ownerId);
      expect(actors.people("Firaz").find(person => person.id === actors.ownerId)?.name).toBe("Firaz");
      actors.bind("session-1", putri, "Putri");
      actors.bind("session-2", putri, "Putri");
      const restored = new MultiplayerActors(file, "firaz-home");
      expect(restored.actorFor("session-2")).toBe(putri);
      expect(restored.nameFor(putri)).toBe("Putri");
      restored.unbind("session-1");
      expect(restored.actorFor("session-1")).toBeNull();
      expect(restored.actorFor("session-2")).toBe(putri);
    } finally { rmSync(dir, { force: true, recursive: true }); }
  });
});
