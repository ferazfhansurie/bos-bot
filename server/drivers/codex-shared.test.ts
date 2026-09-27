import { createServer, type Server } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProviderInstance } from "../contracts.ts";
import { recordEvents } from "../testing/events.ts";
import { CodexDriver } from "./codex.ts";

const fakeAppServer = join(dirname(fileURLToPath(import.meta.url)), "../testing/fake-codex-app-server.ts");
const nativeCli = process.env.BOS_TEST_NATIVE_CODEX;
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

describe.skipIf(process.platform !== "darwin")("Codex shared isolation", () => {
  let root: string;
  let account: string;
  let cli: string;
  let instance: ProviderInstance | undefined;
  let server: Server | undefined;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bos-shared-codex-test-"));
    account = join(root, "account"); mkdirSync(account);
    writeFileSync(join(account, "auth.json"), '{"synthetic":true}');
    cli = join(root, "fake.mjs");
    writeFileSync(cli, `#!/usr/bin/env node
import {readFileSync,writeFileSync,readlinkSync} from 'node:fs';
import {join} from 'node:path';
if(process.argv[2]==='--version') console.log('codex-cli 0.155.1');
else if(process.argv[2]==='app-server') await import(${JSON.stringify(fakeAppServer)});
else { let prompt='';for await(const data of process.stdin)prompt+=data;
const home=process.env.CODEX_HOME;
writeFileSync(process.env.SHARED_DUMP,JSON.stringify({argv:process.argv.slice(2),home,cwd:process.cwd(),prompt,authLink:readlinkSync(join(home,'auth.json'))}));
if(process.env.SHARED_MODE==='hang') setInterval(()=>{},1000);
else if(process.env.SHARED_MODE==='failure'){console.log(JSON.stringify({type:'turn.failed',error:{message:'private diagnostic'}}));process.exitCode=1;}
else {console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'room answer'}}));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:5,output_tokens:2}}));}}
`);
    chmodSync(cli, 0o755);
  });
  afterEach(async () => {
    await instance?.dispose(); instance = undefined;
    if (server) { server.closeAllConnections(); await new Promise<void>((done) => server!.close(() => done())); server = undefined; }
    rmSync(root, { recursive: true, force: true });
  });
  const create = async (mode = "success") => {
    instance = await CodexDriver.create({ instanceId: "shared-test", displayName: "shared", enabled: true,
      config: { cli, fullAuto: true }, environment: { CODEX_HOME: account, HOME: root, SHARED_DUMP: join(root, "dump.json"), SHARED_MODE: mode } });
    return recordEvents(instance.adapter);
  };
  it("preserves model/images and native account while excluding private context and cleaning temporary state", async () => {
    const events = await create();
    const imagePath = join(root, "room.png"); writeFileSync(imagePath, png);
    const { turnId } = await instance!.adapter.sendTurn({ threadId: "shared", text: "latest", recoveryText: "room replay", system: "room instructions",
      model: "gpt-6-astra", effort: "low", approvalMode: "full", cwd: account, resumeCursor: "private-cursor",
      images: [{ path: imagePath, mime: "image/png", bytes: png.length }], sharedContext: { mode: "conversation-only" },
      integrations: { custom: { private: { command: "must-not-run", args: [], env: {} } } } });
    expect(await events.until((e) => e.type === "turn.completed" && e.turnId === turnId)).toMatchObject({ ok: true, usage: { input: 5, output: 2 } });
    const dump = JSON.parse(readFileSync(join(root, "dump.json"), "utf8"));
    expect(dump.prompt).toBe("room replay"); expect(dump.authLink).toBe(join(account, "auth.json"));
    expect(dump.home).not.toBe(account); expect(dump.cwd).not.toBe(account);
    expect(dump.argv).toContain("--ignore-user-config"); expect(dump.argv).toContain("--ignore-rules");
    expect(dump.argv).toContain("gpt-6-astra"); expect(dump.argv).toContain(imagePath);
    expect(dump.argv).toContain('permissions.bos_shared.filesystem={ ":root"="deny" }');
    expect(dump.argv).toContain('approval_policy="never"');
    expect(JSON.stringify(dump)).not.toContain("private-cursor"); expect(JSON.stringify(dump)).not.toContain("must-not-run");
    expect(existsSync(dump.home)).toBe(false); expect(readFileSync(join(account, "auth.json"), "utf8")).toBe('{"synthetic":true}');
    expect(events.events.some((e) => e.type === "content.delta" && e.delta === "room answer")).toBe(true);
  });
  it("refuses keychain-only native accounts before submission", async () => {
    await create(); rmSync(join(account, "auth.json"));
    await expect(instance!.adapter.sendTurn({ threadId: "shared", text: "hi", sharedContext: { mode: "conversation-only" } })).rejects.toThrow("keychain-only");
    expect(existsSync(join(root, "dump.json"))).toBe(false);
  });
  it("reports provider failure without exposing native diagnostics", async () => {
    const events = await create("failure");
    await instance!.adapter.sendTurn({ threadId: "shared", text: "hi", sharedContext: { mode: "conversation-only" } });
    expect(await events.until((e) => e.type === "turn.completed")).toMatchObject({ ok: false });
    expect(JSON.stringify(events.events)).not.toContain("private diagnostic");
  });
  it("queues steering and interrupts the isolated process", async () => {
    const events = await create("hang");
    await instance!.adapter.sendTurn({ threadId: "shared", text: "hi", sharedContext: { mode: "conversation-only" } });
    expect(await instance!.adapter.steer!("shared", "next")).toBe("refused");
    await instance!.adapter.interruptTurn("shared");
    expect(await events.until((e) => e.type === "turn.completed")).toMatchObject({ ok: false, stopReason: "interrupted" });
    expect(instance!.adapter.hasSession?.("shared")).toBe(false);
  });

  it.skipIf(!nativeCli)("native offline runtime denies forged tools and omits private instructions while retaining images", async () => {
    const sentinel = "PRIVATE_NATIVE_FIXTURE_SENTINEL_912";
    writeFileSync(join(account, "AGENTS.md"), sentinel);
    writeFileSync(join(account, "config.toml"), `developer_instructions = "${sentinel}"\n`);
    const privatePath = join(root, "private.txt"); writeFileSync(privatePath, sentinel);
    const requests: any[] = [];
    server = createServer(async (request, response) => {
      let raw = ""; for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw); requests.push(body);
      response.setHeader("content-type", "text/event-stream");
      const item = requests.length === 1
        ? { id: "call1", type: "function_call", call_id: "call1", name: "exec_command", arguments: JSON.stringify({ cmd: `cat ${privatePath}` }) }
        : requests.length === 2
          ? { id: "call2", type: "custom_tool_call", call_id: "call2", name: "apply_patch", input: `*** Begin Patch\n*** Update File: ${privatePath}\n@@\n-unknown\n+changed\n*** End Patch` }
          : { id: "msg1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "safe native reply" }] };
      for (const event of [
        { type: "response.created", response: { id: "response1", status: "in_progress", output: [] } },
        { type: "response.output_item.added", output_index: 0, item }, { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response: { id: "response1", status: "completed", output: [item], usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 } } },
      ]) response.write(`data: ${JSON.stringify(event)}\n\n`);
      response.end();
    });
    await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("missing loopback server");
    instance = await CodexDriver.create({ instanceId: "native-shared", displayName: "offline native", enabled: true,
      config: { cli: nativeCli!, fullAuto: false, managed: { url: `http://127.0.0.1:${address.port}`, models: ["gpt-6-astra"] } },
      environment: { HOME: root, CODEX_HOME: account, OPENMAUSBOT_COMPANY_API_KEY: "synthetic-offline-key" } });
    const events = recordEvents(instance.adapter);
    const imagePath = join(root, "room.png"); writeFileSync(imagePath, png);
    await instance.adapter.sendTurn({ threadId: "native-shared", text: "", model: "gpt-6-astra", system: "Answer only this shared conversation.",
      images: [{ path: imagePath, mime: "image/png", bytes: png.length }], sharedContext: { mode: "conversation-only" } });
    expect(await events.until((e) => e.type === "turn.completed", 25_000)).toMatchObject({ ok: true });
    expect(requests).toHaveLength(3);
    expect(requests.every((request) => !request.tools?.length)).toBe(true);
    expect(JSON.stringify(requests)).not.toContain(sentinel);
    expect(requests[0].input.some((item: any) => item.content?.some((content: any) => content.type === "input_image"))).toBe(true);
    expect(JSON.stringify(requests[1])).toContain("unsupported call: exec_command");
    expect(JSON.stringify(requests[2])).toContain("Failed to read file");
    expect(readFileSync(privatePath, "utf8")).toBe(sentinel);
    expect(events.events.some((event) => event.type === "content.delta" && event.delta === "safe native reply")).toBe(true);
  }, 30_000);
});
