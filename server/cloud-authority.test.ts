import { mkdirSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  AUTHORITY_MOVED_MESSAGE, CLOUD_AUTHORITY_FILE, CloudAuthority, environmentAuthority, FROZEN_AUTHORITY_STATES, isAuthorityGuardedRequest,
  parseCloudAuthorityFlag,
} from "./cloud-authority.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function authority() {
  const dir = mkdtempSync(join(tmpdir(), "omb-cloud-authority-"));
  dirs.push(dir);
  const logs: string[] = [];
  let tick = 1;
  const write = (text: string) => {
    writeFileSync(join(dir, CLOUD_AUTHORITY_FILE), text);
    // Distinct mtimes even when two writes land in one clock tick.
    const at = new Date(Date.now() + tick++ * 1000);
    utimesSync(join(dir, CLOUD_AUTHORITY_FILE), at, at);
  };
  return { gate: new CloudAuthority(dir, (line) => logs.push(line)), write, dir, logs };
}

describe("cloud authority flag", () => {
  it("is no freeze when the file is missing, unreadable, invalid JSON or the wrong shape", () => {
    const { gate, write, dir } = authority();
    expect(gate.frozen()).toBeNull();
    for (const text of ["{", "", "null", "[]", "\"frozen\"",
      JSON.stringify({ epoch: 1, state: "frozen" }),
      JSON.stringify({ workspace_id: "", epoch: 1, state: "frozen" }),
      JSON.stringify({ workspace_id: "ws", epoch: -1, state: "frozen" }),
      JSON.stringify({ workspace_id: "ws", epoch: 1.5, state: "frozen" }),
      JSON.stringify({ workspace_id: "ws", epoch: "01", state: "frozen" }),
      JSON.stringify({ workspace_id: "ws", epoch: 1, state: "FROZEN" }),
      JSON.stringify({ workspace_id: "ws", epoch: 1, state: "paused" }),
      JSON.stringify({ workspace_id: 7, epoch: 1, state: "frozen" }),
    ]) {
      write(text);
      expect(gate.frozen(), text).toBeNull();
      expect(() => gate.assertWritable()).not.toThrow();
      expect(environmentAuthority(gate.current()), text).toBeNull();
    }
    rmSync(join(dir, CLOUD_AUTHORITY_FILE));
    // A directory in the flag's place is unreadable, not a freeze.
    mkdirSync(join(dir, CLOUD_AUTHORITY_FILE));
    expect(gate.frozen()).toBeNull();
  });

  it("is no freeze for inventoried, failed and held", () => {
    const { gate, write } = authority();
    for (const state of ["inventoried", "failed", "held"]) {
      write(JSON.stringify({ workspace_id: "ws_1", epoch: 3, state }));
      expect(gate.current()).toEqual({ workspace_id: "ws_1", epoch: 3, state });
      expect(gate.frozen()).toBeNull();
      // Not moved: the environment descriptor agrees with enforcement.
      expect(environmentAuthority(gate.current())).toBeNull();
    }
  });

  it("freezes frozen through legacy_archived, echoing workspace_id and epoch, and lifts when the file is removed", () => {
    const { gate, write, dir, logs } = authority();
    expect([...FROZEN_AUTHORITY_STATES]).toEqual(["frozen", "imported", "validated", "cloud_active", "legacy_archived"]);
    for (const [state, epoch] of [["frozen", 4], ["imported", "5"], ["validated", 0], ["cloud_active", "18446744073709551616"], ["legacy_archived", 9]] as const) {
      write(JSON.stringify({ workspace_id: "ws_cloud", epoch, state }));
      expect(gate.frozen()).toEqual({ workspace_id: "ws_cloud", epoch, state });
      expect(() => gate.assertWritable("bot turns")).toThrow(expect.objectContaining({
        message: "authority_moved", status: 409, code: "authority_moved",
        body: { error: "authority_moved", workspace_id: "ws_cloud", epoch, message: AUTHORITY_MOVED_MESSAGE },
      }));
      expect(environmentAuthority(gate.current())).toEqual({ state, epoch });
    }
    // One log line per distinct freeze, not per refused dispatch.
    expect(() => gate.assertWritable()).toThrow();
    expect(logs).toHaveLength(5);
    unlinkSync(join(dir, CLOUD_AUTHORITY_FILE));
    expect(gate.frozen()).toBeNull();
    expect(() => gate.assertWritable()).not.toThrow();
  });

  it("carries a sentence for people beside the unchanged machine code", () => {
    expect(AUTHORITY_MOVED_MESSAGE).toBe("This computer's chats moved to BOS cloud. They're read-only here now; keep chatting in Cloud rooms.");
    const { gate, write } = authority();
    write(JSON.stringify({ workspace_id: "ws_1", epoch: 2, state: "frozen" }));
    try { gate.assertWritable(); throw new Error("not refused"); } catch (error) {
      const body = (error as { body: Record<string, unknown> }).body;
      expect(body.error).toBe("authority_moved");
      expect(body.message).toBe(AUTHORITY_MOVED_MESSAGE);
    }
    expect(environmentAuthority(null)).toBeNull();
  });

  it("parses the frozen spec shape", () => {
    expect(parseCloudAuthorityFlag({ workspace_id: "w", epoch: 1, state: "frozen", extra: true })).toEqual({ workspace_id: "w", epoch: 1, state: "frozen" });
    expect(parseCloudAuthorityFlag({ workspace_id: "w", epoch: Number.MAX_SAFE_INTEGER + 1, state: "frozen" })).toBeNull();
  });
});

describe("guarded routes", () => {
  const guarded: Array<[string, string]> = [
    ["POST", "/api/groups"], ["PATCH", "/api/groups/g1"], ["DELETE", "/api/groups/g1"], ["POST", "/api/groups/g1/messages"],
    ["POST", "/api/groups/g1/tasks"], ["PATCH", "/api/groups/g1/tasks/t1"], ["POST", "/api/groups/g1/people"],
    ["DELETE", "/api/groups/g1/queue/q1"], ["POST", "/api/groups/g1/queue/q1/steer"], ["PATCH", "/api/groups/g1/setup"],
    ["POST", "/api/teams/import"],
    ["POST", "/api/threads/t1/messages"], ["POST", "/api/threads/t1/messages/m1/reactions"], ["POST", "/api/threads/t1/respond"],
    ["POST", "/api/bots/b1/messages"], ["POST", "/api/bots/b1/messages/guarded"], ["POST", "/api/bots/b1/messages/m1/edit"],
    ["PATCH", "/api/bots/b1/queue/q1"], ["POST", "/api/bots/b1/queue/q1/steer"], ["POST", "/api/bots/b1/compact"],
    ["POST", "/api/bots/b1/respond"], ["POST", "/api/bots/b1/tasks"], ["DELETE", "/api/bots/b1/tasks/t1"],
    ["POST", "/api/bots/b1/active-branch"], ["POST", "/api/bots/b1/threads/t1/recovery/r1/resume"],
    ["POST", "/api/bots/b1/secret-cards/c1/resume"], ["POST", "/api/bots/b1/connector-cards/c1/resume"],
    ["POST", "/api/bots/b1/history/rollback"], ["PATCH", "/api/bots/b1/cards/c1"], ["DELETE", "/api/bots/b1"],
    ["POST", "/api/multiplayer/rooms"], ["PATCH", "/api/multiplayer/rooms/r1"], ["POST", "/api/multiplayer/rooms/r1/messages"],
    ["PATCH", "/api/multiplayer/rooms/r1/messages/m1"], ["POST", "/api/multiplayer/rooms/r1/leave"], ["POST", "/api/multiplayer/dm"],
    ["POST", "/api/multiplayer/peer-threads/t1/attachments"],
    ["POST", "/api/internal/post-to-room"], ["POST", "/api/internal/delegate-bot"], ["POST", "/api/internal/ask-bot"],
    ["POST", "/api/internal/coordinate-bots"], ["POST", "/api/internal/threads"], ["POST", "/api/internal/threads/t1/close"],
    ["POST", "/api/internal/retry-thread"], ["POST", "/api/internal/create-room"], ["POST", "/api/internal/manage-room"],
    ["POST", "/api/delegated/coordinate"], ["POST", "/api/routines/r1/run"], ["POST", "/api/webhooks/w1/test"],
    ["POST", "/api/calendar-calls/c1/room"],
  ];
  const allowed: Array<[string, string]> = [
    ["GET", "/api/groups"], ["GET", "/api/groups/g1/messages"], ["GET", "/api/threads/t1/messages"], ["HEAD", "/api/bots/b1/messages"],
    ["GET", "/api/multiplayer/rooms/r1/messages"], ["POST", "/api/groups/g1/read"], ["POST", "/api/bots/b1/read"],
    ["POST", "/api/groups/g1/interrupt"], ["POST", "/api/bots/b1/interrupt"], ["PATCH", "/api/multiplayer/rooms/r1/preferences"],
    ["POST", "/api/bots"], ["PATCH", "/api/bots/b1"], ["PATCH", "/api/bots/b1/profile"], ["PUT", "/api/bots/b1/memory"],
    ["POST", "/api/routines"], ["PATCH", "/api/config"], ["POST", "/api/auth/logout"], ["POST", "/api/auth/stream-ticket"],
    ["POST", "/api/attachments"], ["POST", "/api/inbox/clear"],
  ];
  it.each(guarded)("refuses %s %s", (method, path) => expect(isAuthorityGuardedRequest(method, path)).toBe(true));
  it.each(allowed)("allows %s %s", (method, path) => expect(isAuthorityGuardedRequest(method, path)).toBe(false));
});
