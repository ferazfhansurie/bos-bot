import { compatEnv } from "../electron/branding-env.cjs";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { expect, it } from "vitest";
import { z } from "zod";

import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";

type Bot = { id: string; threadId: string; name: string };
type Room = { id: string; name: string; memberIds: string[]; section?: string; bulletin: string; working?: boolean };
type RpcReply = { result: { isError?: boolean; content: Array<{ text: string }> } };

it("creates and manages an own-section room through the mounted Chief MCP proxy", async () => {
  const fixture = await launchVerificationServer({ ...compatEnv, FAKE_CLAUDE_MODE: "hang" });
  const evidence: unknown[] = [{ fixture: fixture.info }];
  let proxy: ChildProcess | undefined;
  const control = async (args: string[]) => {
    const result = await runControlOmb([...args, "--url", fixture.info.url]);
    evidence.push({ command: args, result });
    return result;
  };
  const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method, headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    expect(response.ok, `${method} ${path}`).toBe(true);
    return await response.json() as T;
  };
  try {
    await api("PATCH", "/api/config", { threads: { maxConcurrentPerBot: 1 } });
    const bots: Bot[] = [];
    for (const name of ["Fixture Chief", "Fixture Peer", "Fixture Second", "Foreign Peer"]) {
      const { bot } = await control(["new-bot", "--name", name]) as { bot: Bot };
      bots.push(bot);
      await api("PATCH", `/api/bots/${bot.id}`, { section: name === "Foreign Peer" ? "Private" : "Room verification" });
    }
    const [chief, peer, second, foreign] = bots;
    await api("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true });
    await control(["send", "--bot", chief.id, "--text", "Set up a small room for the team."]);
    await expect.poll(() => existsSync(fixture.fixtureDumpPath), { timeout: 15_000 }).toBe(true);
    const { mcpConfig } = z.object({ mcpConfig: z.object({ mcpServers: z.object({
      agents: z.object({ command: z.string(), args: z.array(z.string()), env: z.record(z.string(), z.string()) }),
    }) }) }).parse(JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")));
    const mounted = mcpConfig.mcpServers.agents;
    expect(mounted.env.OMB_BOT_ID).toBe(chief.id);
    expect(mounted.env.OMB_HARNESS_URL).toBe(fixture.info.url);
    proxy = spawn(mounted.command, mounted.args, {
      cwd: process.cwd(),
      env: { ...mounted.env, HOME: fixture.info.dataDir, USERPROFILE: fixture.info.dataDir, ...(compatEnv.SystemRoot ? { SystemRoot: compatEnv.SystemRoot } : {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const pending = new Map<number, (reply: RpcReply) => void>();
    let nextId = 0;
    createInterface({ input: proxy.stdout! }).on("line", (line) => {
      const reply = JSON.parse(line) as RpcReply & { id: number };
      pending.get(reply.id)?.(reply);
    });
    const tool = async (name: string, args: Record<string, unknown>, denied = false) => {
      const id = ++nextId;
      const reply = await new Promise<RpcReply>((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${name} did not answer`)); }, 10_000);
        pending.set(id, (result) => { clearTimeout(timer); pending.delete(id); resolve(result); });
        proxy!.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\n");
      });
      evidence.push({ tool: name, args, result: reply.result });
      expect(Boolean(reply.result.isError), JSON.stringify(reply.result)).toBe(denied);
      return reply.result.content.map((item) => item.text).join("\n");
    };
    const rooms = async () => (await api<{ groups: Room[] }>("GET", "/api/bots?messages=0")).groups;
    await tool("create_room", { name: "Review room", member_bot_ids: [peer.id], bulletin: "Review only the assigned change." });
    const room = (await rooms()).find((candidate) => candidate.name === "Review room")!;
    expect(room).toMatchObject({ section: "Room verification", memberIds: [chief.id, peer.id], working: false });
    expect(await tool("list_rooms", {})).toContain(room.id);
    await tool("manage_room", { room_id: room.id, action: "rename", name: "Verified room" });
    await tool("manage_room", { room_id: room.id, action: "add_members", member_bot_ids: [second.id] });
    await tool("manage_room", { room_id: room.id, action: "remove_members", member_bot_ids: [peer.id] });
    await tool("manage_room", { room_id: room.id, action: "set_bulletin", bulletin: "Verified short brief ✓" });
    const saved = (await rooms()).find((candidate) => candidate.id === room.id);
    expect(saved).toMatchObject({ name: "Verified room", memberIds: [chief.id, second.id], bulletin: "Verified short brief ✓", section: "Room verification" });
    evidence.push({ saved });
    await tool("create_room", { name: "Forbidden room", member_bot_ids: [foreign.id] }, true);
    await tool("manage_room", { room_id: room.id, action: "add_members", member_bot_ids: [foreign.id] }, true);
    expect((await rooms()).find((candidate) => candidate.id === room.id)).toEqual(saved);
    expect((await rooms()).some((candidate) => candidate.name === "Forbidden room")).toBe(false);
    // Metadata and roster management remain available while a teammate works.
    await control(["send-channel", "--channel", room.id, "--text", "@Fixture Second keep working."]);
    await expect.poll(async () => (await rooms()).find((candidate) => candidate.id === room.id)?.working).toBe(true);
    const modelSwitch = await fetch(`${fixture.info.url}/api/bots/${second.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ modelSelection: { instanceId: "claude", model: "busy-room-switch" } }) });
    expect(modelSwitch.status).toBe(409);
    await tool("manage_room", { room_id: room.id, action: "add_members", member_bot_ids: [peer.id] });
    await tool("manage_room", { room_id: room.id, action: "set_bulletin", bulletin: "New turns use this brief." });
    await tool("manage_room", { room_id: room.id, action: "remove_members", member_bot_ids: [second.id] });
    expect((await rooms()).find((candidate) => candidate.id === room.id)).toMatchObject({ memberIds: [chief.id, peer.id], bulletin: "New turns use this brief.", working: true });
    await tool("manage_room", { room_id: room.id, action: "remove_members", member_bot_ids: [chief.id] }, true);
    await tool("manage_room", { room_id: room.id, action: "add_members", member_bot_ids: [foreign.id] }, true);
    for (const [path, body] of [
      [`/api/groups/${room.id}/tasks`, {}],
      [`/api/groups/${room.id}`, { defaultResponder: { kind: "everyone" } }],
      [`/api/groups/${room.id}`, { memberReplyModes: { [peer.id]: "always" } }],
    ] as const) {
      const response = await fetch(`${fixture.info.url}${path}`, { method: path.endsWith("/tasks") ? "POST" : "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      expect(response.status).toBe(409);
    }
    await control(["interrupt", "--channel", room.id]);

    // Removing a member waiting on a private conversation releases only its
    // pending room dispatch, without cancelling the private provider turn.
    await control(["send", "--bot", peer.id, "--text", "Private work stays running."]);
    await expect.poll(async () => (await api<{ bots: Array<{ id: string; busy: boolean }> }>("GET", "/api/bots?messages=0")).bots.find((candidate) => candidate.id === peer.id)?.busy).toBe(true);
    await tool("create_room", { name: "Pending room", member_bot_ids: [peer.id] });
    const pendingRoom = (await rooms()).find((candidate) => candidate.name === "Pending room")!;
    await control(["send-channel", "--channel", pendingRoom.id, "--text", "@Fixture Peer wait for your private work."]);
    await expect.poll(async () => (await rooms()).find((candidate) => candidate.id === pendingRoom.id)?.working).toBe(true);
    await tool("manage_room", { room_id: pendingRoom.id, action: "remove_members", member_bot_ids: [peer.id] });
    await expect.poll(async () => (await rooms()).find((candidate) => candidate.id === pendingRoom.id)?.working).toBe(false);
    const roster = await api<{ bots: Array<{ id: string; busy: boolean }> }>("GET", "/api/bots?messages=0");
    expect(roster.bots.find((candidate) => candidate.id === peer.id)?.busy).toBe(true);
    await control(["interrupt", "--bot", peer.id]);
    await control(["messages", "--channel", room.id, "--limit", "10"]);
    await control(["interrupt", "--bot", chief.id]);
    await tool("manage_room", { room_id: room.id, action: "rename", name: "Expired turn" }, true);
    expect((await rooms()).find((candidate) => candidate.id === room.id)?.name).toBe("Verified room");
  } finally {
    if (proxy) await waitForExit(proxy, { signal: "SIGTERM" });
    await fixture.close();
    const evidencePath = `${fixture.info.logPath}.chief-rooms.json`;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    expect(existsSync(fixture.info.dataDir)).toBe(false);
    console.info(JSON.stringify({ ...fixture.info, evidencePath, fixtureRemoved: true, exitCode: fixture.child.exitCode }));
  }
}, 60_000);
// branding compatibility (electron/branding-compat.json): environment-aliases: legacy launchd/systemd and provider subprocess environment labels stay accepted; the central resolver always prefers the new spelling
