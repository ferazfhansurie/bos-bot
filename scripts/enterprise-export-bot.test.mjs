import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./enterprise-export-bot.mjs", import.meta.url));
const CLIENT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ATT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png";
const OTHER_ATT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.png";

function server({ clientMemory = "# memory\nprices for the studio\n", soul = "you run the studio. never share other clients, personal or ops data.\n" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "bos-export-"));
  const data = join(root, "data");
  const put = (p, body) => { mkdirSync(join(data, p, ".."), { recursive: true }); writeFileSync(join(data, p), body); };
  put("bots.json", JSON.stringify([
    { id: CLIENT, name: "studio", soul, threadId: "t-client-main", modelSelection: { instanceId: "claude-ours", model: "x" }, fallbackModel: { instanceId: "claude-ours" }, mcpServers: ["studio-tools"], cwd: "/home/us/secret",
      tasks: [{ threadId: "t-client-main", title: "main", createdAt: 1, resumeCursors: { codex: "sess-ours" }, cwd: "/home/us/secret", openedBy: { botId: OTHER } },
        { threadId: "t-client-task", title: "task", createdAt: 2, resumeCursors: {} }],
      peers: [OTHER], composio: true, section: "Clients", computer: "local", resumeCursors: { x: 1 }, sharedWith: ["u1"], approvalMode: "full" },
    { id: OTHER, name: "widgetco", threadId: "t-other-main", tasks: [{ threadId: "t-other-main" }] },
  ]));
  put("groups.json", JSON.stringify([{ id: "room-0000-ours", threadId: "t-room-thread" }]));
  put("config.json", JSON.stringify({ features: { managedCodex: true, marketplacePublisher: true, showToolCalls: true }, instances: { ours: { config: { apiKey: "OURSECRETVALUE1234567890" } } }, onboarding: { completedAt: 1, businessBrief: "our agency brief" }, profile: { avatarUrl: "ours.png" }, composio: { key: "x" } }));
  put(`workspaces/${CLIENT}/MEMORY.md`, clientMemory);
  put(`workspaces/${CLIENT}/tools/old-linux-build.log`, "widgetco was here\n");
  put(`workspaces/${OTHER}/MEMORY.md`, "widgetco secrets\n");
  put(`bots/${CLIENT}/SOUL.md`, soul);
  put(`bots/${CLIENT}/history.ndjson`, '{"soul":"old soul for widgetco"}\n');
  put(`attachments/${ATT}`, "client-png");
  put(`attachments/${OTHER_ATT}`, "other-png");
  const db = new DatabaseSync(join(data, "messages.db"));
  db.exec(`CREATE TABLE messages (thread_id TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL, role TEXT NOT NULL, kind TEXT NOT NULL, text TEXT, json TEXT NOT NULL, PRIMARY KEY (thread_id, id));
    CREATE INDEX messages_thread ON messages(thread_id);
    CREATE TABLE thread_state (thread_id TEXT PRIMARY KEY, active_leaf_id TEXT);
    CREATE TABLE chat_followups (id TEXT PRIMARY KEY, kind TEXT NOT NULL, owner_id TEXT NOT NULL, thread_id TEXT NOT NULL, send_id TEXT, status TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE command_receipts (kind TEXT NOT NULL, key TEXT NOT NULL, at INTEGER NOT NULL, result TEXT NOT NULL, PRIMARY KEY (kind, key));
    CREATE TABLE chat_queue_pauses (kind TEXT NOT NULL, owner_id TEXT NOT NULL, thread_id TEXT NOT NULL, PRIMARY KEY (kind, owner_id, thread_id));
    CREATE TABLE memory_files (bot_id TEXT NOT NULL, path TEXT NOT NULL, text TEXT NOT NULL, mtime_ms INTEGER NOT NULL, bytes INTEGER NOT NULL, PRIMARY KEY (bot_id, path));
    CREATE TABLE usage_ledger (bot_id TEXT, note TEXT);
    CREATE VIRTUAL TABLE messages_fts USING fts5(text, content='messages', content_rowid='rowid', tokenize='unicode61');
    CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages BEGIN INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text); END;
    CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text); END;
    CREATE TRIGGER messages_fts_au AFTER UPDATE ON messages BEGIN INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text); INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text); END;
    CREATE VIRTUAL TABLE memory_fts USING fts5(text, content='memory_files', content_rowid='rowid', tokenize='unicode61');
    CREATE TRIGGER memory_fts_ai AFTER INSERT ON memory_files BEGIN INSERT INTO memory_fts(rowid, text) VALUES (new.rowid, new.text); END;`);
  const msg = db.prepare("INSERT INTO messages VALUES (?, ?, 1, 'user', 'text', ?, ?)");
  db.exec("BEGIN");
  for (let i = 0; i < 2000; i++) msg.run("t-other-main", `o${i}`, `zebracorp invoice ${i} for widgetco othercustomer`, JSON.stringify({ pad: "x".repeat(200) }));
  msg.run("t-client-main", "m1", "hello studio booking", JSON.stringify({ attachments: [{ path: `/attachments/${ATT}` }] }));
  msg.run("t-client-task", "m2", "follow up on the booking", "{}");
  msg.run("t-other-main", "m3", "another widgetco note", JSON.stringify({ attachments: [{ path: OTHER_ATT }] }));
  db.exec("COMMIT");
  db.prepare("INSERT INTO thread_state VALUES (?, 'm1')").run("t-client-main");
  db.prepare("INSERT INTO thread_state VALUES (?, 'x')").run("t-other-main");
  db.prepare("INSERT INTO chat_followups VALUES ('f1', 'channel', 'group-x', 't-client-main', null, 'open', ?)").run('{"text":"widgetco owes RM50k"}');
  db.prepare("INSERT INTO command_receipts VALUES ('k', 'key', 1, '{}')").run();
  db.prepare("INSERT INTO memory_files VALUES (?, 'MEMORY.md', 'memzebra widgetco', 1, 16)").run(OTHER);
  db.prepare("INSERT INTO usage_ledger VALUES (?, 'widgetco usage')").run(OTHER);
  db.close();
  writeFileSync(join(root, "deny.txt"), "# other clients\nwidgetco\nacme\n/globex\\d*/\n李明\n@widgetco.my\n@zz-corp.my\nzénith\nstudio\n");
  const tools = join(root, "build-tools.mjs");
  writeFileSync(tools, `import {mkdirSync,writeFileSync} from "node:fs";const d=process.argv[2];mkdirSync(d+"/secrets",{recursive:true});writeFileSync(d+"/studio-mcp.mjs","// bundle\\n");writeFileSync(d+"/secrets/db.env","DATABASE_URL=postgres://u:p@h/db\\n");`);
  const addMessage = (thread, id, text, json = "{}") => {
    const d = new DatabaseSync(join(data, "messages.db"));
    d.prepare("INSERT INTO messages VALUES (?, ?, 1, 'bot', 'text', ?, ?)").run(thread, id, text, json);
    d.close();
  };
  const editBots = (fn) => { const p = join(data, "bots.json"); const b = JSON.parse(readFileSync(p, "utf8")); fn(b); writeFileSync(p, JSON.stringify(b)); };
  const rawMessage = (thread, id, json) => {
    const d = new DatabaseSync(join(data, "messages.db"));
    d.prepare("INSERT INTO messages VALUES (?, ?, 1, 'bot', 'text', '', ?)").run(thread, id, json);
    d.close();
  };
  const tool = (body) => writeFileSync(tools, `import {mkdirSync,writeFileSync,symlinkSync} from "node:fs";const d=process.argv[2];mkdirSync(d+"/data",{recursive:true});writeFileSync(d+"/studio-mcp.mjs","// bundle\\n");${body}`);
  return { root, data, put, addMessage, editBots, rawMessage, tool, deny: join(root, "deny.txt"), tools, out: join(root, "out") };
}

const args = (s, extra = []) => [script, "--source", s.data, "--bot", CLIENT, "--slug", "studio", "--label", "Studio",
  "--out", s.out, "--deny", s.deny, "--allow", "studio", "--tools", s.tools, "--mcp", "studio-tools=studio-mcp.mjs", ...extra];
const run = (s, extra) => spawnSync(process.execPath, args(s, extra), { encoding: "utf8" });
const withServer = (opts, fn) => { const s = server(opts); try { fn(s); } finally { rmSync(s.root, { recursive: true, force: true }); } };
const ok = (r) => assert.equal(r.status, 0, r.stderr);
const fails = (r, pattern) => { assert.notEqual(r.status, 0, "export should fail"); assert.match(r.stderr, pattern); };

test("exports only the client bot, its threads and its attachments", () => withServer({}, (s) => {
  ok(run(s));
  const bots = JSON.parse(readFileSync(join(s.out, "bots.json"), "utf8"));
  assert.equal(bots.length, 1);
  const [bot] = bots;
  assert.equal(bot.id, CLIENT);
  assert.equal(bot.computer, "off");
  assert.deepEqual(bot.resumeCursors, {});
  for (const k of ["peers", "composio", "section", "cwd", "sharedWith", "approvalMode"]) assert.equal(bot[k], undefined, k);
  assert.deepEqual(bot.tasks[0], { threadId: "t-client-main", title: "main", createdAt: 1, resumeCursors: {} });
  assert.equal(bot.soulHash, createHash("sha256").update(bot.soul, "utf8").digest("hex"));
  assert.equal(readFileSync(join(s.out, `bots/${CLIENT}/SOUL.md`), "utf8"), bot.soul);
  assert.deepEqual(bot.modelSelection, { instanceId: "codex", model: "gpt-6.1-sol" });
  assert.equal(bot.fallbackModel, undefined);
  assert.deepEqual(JSON.parse(readFileSync(join(s.out, "config.json"), "utf8")), { features: { showToolCalls: true }, onboarding: { completedAt: 1 }, profile: { name: "Studio" } });
  for (const p of [`workspaces/${OTHER}`, "groups.json", `bots/${CLIENT}/history.ndjson`, `workspaces/${CLIENT}/tools/old-linux-build.log`, `attachments/${OTHER_ATT}`]) {
    assert.equal(existsSync(join(s.out, p)), false, p);
  }
  assert.equal(existsSync(join(s.out, `attachments/${ATT}`)), true);
  const db = new DatabaseSync(join(s.out, "messages.db"), { readOnly: true });
  assert.deepEqual(db.prepare("SELECT thread_id FROM messages ORDER BY id").all().map((x) => x.thread_id), ["t-client-main", "t-client-task"]);
  assert.deepEqual(db.prepare("SELECT thread_id FROM thread_state").all().map((x) => x.thread_id), ["t-client-main"]);
  for (const t of ["chat_followups", "command_receipts", "chat_queue_pauses", "memory_files", "usage_ledger"]) assert.equal(db.prepare(`SELECT count(*) n FROM ${t}`).get().n, 0, t);
  assert.equal(db.prepare("SELECT count(*) n FROM messages_fts WHERE messages_fts MATCH 'booking'").get().n, 2);
  db.close();
  const setup = JSON.parse(readFileSync(join(s.root, "out.setup.json"), "utf8"));
  assert.deepEqual(setup.instances, { codex: { driver: "codex", displayName: "ChatGPT" } });
  assert.deepEqual(setup.mcpServers["studio-tools"].args, [`{{DATA_DIR}}/workspaces/${CLIENT}/tools/studio-mcp.mjs`]);
  assert.equal(setup.bots[CLIENT].modelSelection.model, "gpt-6.1-sol");
}));

test("no other client's bytes anywhere in the shipped database", () => withServer({}, (s) => {
  ok(run(s));
  const raw = readFileSync(join(s.out, "messages.db")).toString("latin1");
  for (const word of ["zebracorp", "othercustomer", "widgetco", "memzebra", OTHER]) assert.equal(raw.includes(word), false, word);
}));

test("private modes, nothing left behind on failure, refuses an existing out dir", () => withServer({}, (s) => {
  ok(run(s));
  assert.equal(statSync(join(s.out, "messages.db")).mode & 0o777, 0o600);
  assert.equal(statSync(join(s.out, "workspaces")).mode & 0o777, 0o700);
  fails(run(s), /already exists/);
  rmSync(s.out, { recursive: true });
  rmSync(join(s.root, "out.setup.json"));
  s.addMessage("t-client-main", "m9", "ask globex2 about it");
  fails(run(s), /m9: other-client text/);
  assert.deepEqual(readdirSync(s.root).filter((n) => n.startsWith("out")), []);
}));

test("redacts other-client lines in soul and markdown, keeps the rule line", () => withServer({
  clientMemory: "prices for the studio\nlast job for widgetco was late\nno other-client/personal/ops history.\n",
  soul: "you run the studio.\nnever share other clients, personal or ops data.\nnever share other clients data. our widgetco account is RM90k.\n",
}, (s) => {
  ok(run(s));
  const memory = readFileSync(join(s.out, `workspaces/${CLIENT}/MEMORY.md`), "utf8");
  assert.match(memory, /prices for the studio/);
  assert.match(memory, /no other-client\/personal\/ops history/);
  assert.doesNotMatch(memory, /widgetco/);
  const [bot] = JSON.parse(readFileSync(join(s.out, "bots.json"), "utf8"));
  assert.match(bot.soul, /never share other clients, personal or ops data/);
  assert.doesNotMatch(bot.soul, /widgetco/);
}));

test("the rule phrase does not exempt a message that also names another client", () => withServer({}, (s) => {
  s.addMessage("t-client-main", "m9", "note", JSON.stringify({ out: "widgetco owes RM50k. reminder: never mix other clients data" }));
  fails(run(s), /m9: other-client text/);
}));

test("matches non-latin names and terms with punctuation", () => {
  for (const text of ["call 李明 tomorrow", "mail sales@widgetco.my"]) {
    withServer({}, (s) => { s.addMessage("t-client-main", "m9", text); fails(run(s), /m9: other-client text/); });
  }
});

test("fails on keys, foreign ids, file names and unknown binaries", () => {
  withServer({ clientMemory: "key sk-ant-abcdefghijklmnopqrstuvwxyz0123\n" }, (s) => fails(run(s), /MEMORY.md: looks like a credential/));
  withServer({ clientMemory: "auth: Bearer abcdefghijklmnopqrstuvwxyz\n" }, (s) => fails(run(s), /MEMORY.md: looks like a credential/));
  withServer({}, (s) => { s.addMessage("t-client-main", "m9", `asked bot ${OTHER}`); fails(run(s), /m9: another bot's/); });
  withServer({}, (s) => { s.addMessage("t-client-main", "m9", "see room-0000-ours"); fails(run(s), /m9: another bot's, thread's or room's id/); });
  withServer({}, (s) => { s.put(`workspaces/${CLIENT}/widgetco-invoice.csv`, "a,b\n"); fails(run(s), /path .*widgetco-invoice.csv: other-client text/); });
  withServer({}, (s) => {
    s.put(`workspaces/${CLIENT}/report.xlsx`, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe, 0x00]));
    fails(run(s), /report.xlsx: binary file/);
    ok(run(s, ["--allow-binary", `workspaces/${CLIENT}/report.xlsx`]));
  });
});

test("refuses symlinks and never writes through them", () => withServer({}, (s) => {
  symlinkSync(join(s.data, `workspaces/${OTHER}/MEMORY.md`), join(s.data, `workspaces/${CLIENT}/shared.md`));
  fails(run(s), /symlinks or special files/);
  assert.equal(readFileSync(join(s.data, `workspaces/${OTHER}/MEMORY.md`), "utf8"), "widgetco secrets\n");
}));

test("needs a mac build for every bot tool", () => withServer({}, (s) => {
  const r = spawnSync(process.execPath, [script, "--source", s.data, "--bot", CLIENT, "--slug", "studio", "--label", "Studio",
    "--out", s.out, "--deny", s.deny, "--allow", "studio"], { encoding: "utf8" });
  fails(r, /uses studio-tools but no Mac build/);
}));

test("leaves skipped threads behind and rewrites --replace literals", () => withServer({}, (s) => {
  s.addMessage("t-client-task", "m8", "sent to widgetco bot");
  s.addMessage("t-client-main", "m7", "key at /keys/acme-sa.json");
  mkdirSync(join(s.data, `task-workspaces/${CLIENT}/t-client-task`), { recursive: true });
  ok(run(s, ["--skip-thread", "t-client-task", "--replace", "acme-sa.json=service-account.json"]));
  const [bot] = JSON.parse(readFileSync(join(s.out, "bots.json"), "utf8"));
  assert.deepEqual(bot.tasks.map((t) => t.threadId), ["t-client-main"]);
  assert.equal(existsSync(join(s.out, `task-workspaces/${CLIENT}/t-client-task`)), false);
  const db = new DatabaseSync(join(s.out, "messages.db"), { readOnly: true });
  assert.deepEqual(db.prepare("SELECT text FROM messages ORDER BY id").all().map((x) => x.text), ["hello studio booking", "key at /keys/service-account.json"]);
  db.close();
  assert.equal(readFileSync(join(s.out, "messages.db")).toString("latin1").includes("acme-sa"), false);
  rmSync(s.out, { recursive: true });
  fails(run(s, ["--skip-thread", "t-client-task", "--skip-thread", "t-client-main"]), /every thread was skipped/);
  fails(run(s, ["--replace", 'ab"c=x']), /--replace/);
}));

test("claude engine writes a claudeAgent instance", () => withServer({}, (s) => {
  ok(run(s, ["--engine", "claude"]));
  const setup = JSON.parse(readFileSync(join(s.root, "out.setup.json"), "utf8"));
  assert.deepEqual(setup.features, { managedClaude: true });
  assert.equal(setup.instances.claude.driver, "claudeAgent");
  assert.equal(setup.bots[CLIENT].modelSelection.model, "claude-opus-5-5");
}));

test("tool bundles may name keys in code but not hold a literal one", () => {
  const bundle = (body) => (s) => writeFileSync(s.tools, `import {mkdirSync,writeFileSync} from "node:fs";const d=process.argv[2];mkdirSync(d,{recursive:true});writeFileSync(d+"/studio-mcp.mjs",${JSON.stringify(body)});`);
  withServer({}, (s) => { bundle("this.password = config.password;\nconst tokens = res.data;\nthis.credentials = { refresh_token: \"jwt-placeholder\" };\n")(s); ok(run(s)); });
  withServer({}, (s) => { bundle('const password = "hunter2hunter2";\n')(s); fails(run(s), /studio-mcp.mjs: looks like a credential/); });
});

test("json escapes, accents, invisible and fullwidth characters can't hide a word, key or id", () => {
  const cases = [
    JSON.stringify({ out: "ok\nwidgetco owes RM50k" }),
    JSON.stringify({ out: "ok\twidgetco" }),
    JSON.stringify({ out: "key\nsk-ant-abcdefghijklmnopqrstuvwxyz0123" }),
    '{"out":"widg\\u0065tco"}',
    JSON.stringify({ out: "zénith studio" }),
    JSON.stringify({ out: "widg​etco" }),
    JSON.stringify({ out: "ｗｉｄｇｅｔｃｏ" }),
    `{"out":"${OTHER.replace(/-/g, "\\u002d")}"}`,
  ];
  for (const json of cases) withServer({}, (s) => { s.rawMessage("t-client-main", "m9", json); fails(run(s), /m9: /); });
  withServer({}, (s) => { s.editBots((b) => { b[0].description = "x\nAKIAABCDEFGHIJKLMNOP"; }); fails(run(s), /bots.json: looks like a credential/); });
  withServer({}, (s) => { s.editBots((b) => { b[0].tasks[0].title = "main\nwidgetco"; }); fails(run(s), /bots.json: other-client text/); });
});

test("camel, snake and @domain names are words too", () => {
  withServer({}, (s) => { s.addMessage("t-client-main", "m9", "ask WidgetcoBot"); fails(run(s), /m9: other-client text/); });
  withServer({}, (s) => { s.addMessage("t-client-main", "m9", "mail boss@zz-corp.my"); fails(run(s), /m9: other-client text/); });
  withServer({}, (s) => { s.put(`workspaces/${CLIENT}/widgetco_notes.csv`, "a\n"); fails(run(s), /path .*widgetco_notes.csv/); });
  withServer({}, (s) => { mkdirSync(join(s.data, `workspaces/${CLIENT}/widgetco-archive`)); fails(run(s), /path .*widgetco-archive/); });
});

test("room tasks and members are other people's ids", () => withServer({}, (s) => {
  s.put("groups.json", JSON.stringify([{ id: "room-0000-ours", threadId: "t-room-thread", tasks: [{ threadId: "t-room-task-two" }], people: [{ id: "person-0000-x" }] }]));
  s.addMessage("t-client-main", "m9", "continued in t-room-task-two");
  fails(run(s), /m9: another bot's, thread's or room's id/);
}));

test("a secret held elsewhere on our server fails wherever it shows up", () => withServer({ clientMemory: "use OURSECRETVALUE1234567890 here\n" }, (s) => {
  fails(run(s), /MEMORY.md: holds a secret from elsewhere/);
}));

test("credentials a client's stack writes", () => {
  for (const line of ["password: p@ssW0rd!2026x", "Authorization: Basic dXNlcjpwYXNzd29yZA==", "https://discord.com/api/webhooks/123456/abcdefghijklmnopqrstuvwxyz"]) {
    withServer({ clientMemory: `${line}\n` }, (s) => fails(run(s), /MEMORY.md: looks like a credential/));
  }
  withServer({}, (s) => { s.addMessage("t-client-main", "m9", "used", JSON.stringify({ usage: { tokens: 12345678 } })); ok(run(s)); });
});

test("tool builds: words checked in code, literal keys caught, symlinks refused, knowledge redacted", () => {
  withServer({}, (s) => { s.tool(`writeFileSync(d+"/data/clients.js","const CLIENTS={widgetco:{sheet:1}};");`); fails(run(s), /clients.js: other-client text/); });
  withServer({}, (s) => { s.tool(`writeFileSync(d+"/studio-mcp.mjs","const key = process.env.K || 'Zq8xP2mVt7LwR4nB9cYh';\\n");`); fails(run(s), /studio-mcp.mjs: looks like a credential/); });
  withServer({}, (s) => { s.tool(`writeFileSync(d+"/studio-mcp.mjs","const auth = {user:'ops', pass:'Zq8xP2mVt7LwR4nB9cYh'};\\n");`); fails(run(s), /studio-mcp.mjs: looks like a credential/); });
  withServer({}, (s) => {
    const outside = join(s.root, "outside.txt");
    writeFileSync(outside, "hi\n", { mode: 0o644 });
    s.tool(`symlinkSync(${JSON.stringify(outside)}, d+"/data/link.txt");`);
    fails(run(s), /symlinks or special files in the export/);
    assert.equal(statSync(outside).mode & 0o777, 0o644);
  });
  withServer({}, (s) => {
    s.tool(`writeFileSync(d+"/data/knowledge.json",JSON.stringify([{text:"opening hours 9-5\\nwe did widgetco's site too"}]));`);
    ok(run(s));
    const [page] = JSON.parse(readFileSync(join(s.out, `workspaces/${CLIENT}/tools/data/knowledge.json`), "utf8"));
    assert.equal(page.text, "opening hours 9-5\n[removed: not this client's data]");
  });
});

test("client secrets are listed and still checked for other clients' names", () => {
  const secret = (body) => (s) => s.tool(`mkdirSync(d+"/secrets",{recursive:true});writeFileSync(d+"/secrets/g.env",${JSON.stringify(body)});`);
  withServer({}, (s) => { secret("# widgetco sheet\nK=1\n")(s); fails(run(s), /secrets\/g.env: other-client text/); });
  withServer({}, (s) => { secret(`K=1 ${OTHER}\n`)(s); fails(run(s), /secrets\/g.env: another bot's/); });
  withServer({}, (s) => {
    secret('SA={"project_id":"acme-proj-1","private_key":"-----BEGIN PRIVATE KEY-----"}\n')(s);
    fails(run(s), /secrets\/g.env: other-client text/);
    const r = run(s, ["--allow-in-secrets", "acme-proj-1"]);
    ok(r);
    assert.deepEqual(JSON.parse(r.stdout).secrets, ["g.env (SA)"]);
  });
});

test("media must be real media; attachments another thread names stay behind", () => {
  withServer({}, (s) => { s.put(`workspaces/${CLIENT}/photo.png`, Buffer.from([0xff, 0xfe, 0x00, 0x77])); fails(run(s), /photo.png: binary file that isn't plain media/); });
  withServer({}, (s) => {
    s.put(`workspaces/${CLIENT}/real.png`, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe]), Buffer.from(OTHER)]));
    fails(run(s), /real.png: another bot's/);
  });
  withServer({}, (s) => { s.addMessage("t-client-main", "m9", `see ${OTHER_ATT}`); fails(run(s), /attachment .*: also in thread t-other-main/); });
});

test("only kept threads' folders ship; ids and stale partials are checked", () => {
  withServer({}, (s) => {
    s.put(`task-workspaces/${CLIENT}/t-deleted/notes.txt`, "old\n");
    s.put(`task-workspaces/${CLIENT}/t-client-task/notes.txt`, "kept\n");
    ok(run(s));
    assert.equal(existsSync(join(s.out, `task-workspaces/${CLIENT}/t-deleted`)), false);
    assert.equal(existsSync(join(s.out, `task-workspaces/${CLIENT}/t-client-task/notes.txt`)), true);
  });
  withServer({}, (s) => { s.editBots((b) => { b[0].tasks[1].threadId = "../../x"; }); fails(run(s), /is not a plain id/); });
  withServer({}, (s) => { mkdirSync(`${s.out}.partial-999`); fails(run(s), /killed half way/); });
});

test("nested json, escapes in strings and code, and accents can't hide a word or id", () => {
  const nested = (inner) => JSON.stringify({ tools: [{ output: JSON.stringify(inner) }] });
  withServer({}, (s) => { s.rawMessage("t-client-main", "m9", nested({ addr: "a\nwidgetco sdn bhd" })); fails(run(s), /m9: other-client text/); });
  withServer({}, (s) => { s.rawMessage("t-client-main", "m9", nested({ k: "x\nsk-ant-api03-abcdefghijklmnopqrstuvwxyz" })); fails(run(s), /m9: looks like a credential/); });
  withServer({}, (s) => { s.rawMessage("t-client-main", "m9", JSON.stringify({ out: '{"client": "z\\u00e9nith hq"}' })); fails(run(s), /m9: other-client text/); });
  withServer({}, (s) => { s.rawMessage("t-client-main", "m9", nested({ id: OTHER.replaceAll("-", "\\u002d") })); fails(run(s), /m9: another bot's/); });
  withServer({}, (s) => { s.tool(`writeFileSync(d+"/studio-mcp.mjs",'const KB = "intro\\\\nwidgetco pricing RM9k";\\n');`); fails(run(s), /studio-mcp.mjs: other-client text/); });
  withServer({ clientMemory: '# notes\n"a\\nwidgetco"\n' }, (s) => fails(run(s), /MEMORY.md: other-client text/));
  withServer({ clientMemory: "# notes\ncall Zénith today\n" }, (s) => { ok(run(s)); assert.doesNotMatch(readFileSync(join(s.out, `workspaces/${CLIENT}/MEMORY.md`), "utf8"), /nith/); });
  withServer({}, (s) => { s.rawMessage("t-client-main", "m9", JSON.stringify({ t: "Zénith booking" })); fails(run(s), /m9: other-client text/); });
  withServer({}, (s) => { s.rawMessage("t-client-main", "m9", JSON.stringify({ t: "lunch with Ácmé" })); fails(run(s), /m9: other-client text/); });
});

test("our logins and other clients' keys never ship, not even in the client's secrets", () => {
  const secrets = (body) => `mkdirSync(d+"/secrets",{recursive:true});writeFileSync(d+"/secrets/llm.env",${JSON.stringify(body)});`;
  withServer({}, (s) => { s.tool(secrets("ANTHROPIC_API_KEY=sk-ant-oat01-abcdefghijklmnopqrstuvwxyz\n")); fails(run(s), /llm.env: holds one of our own logins/); });
  withServer({}, (s) => {
    const jwt = `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { plan: "pro" } })).toString("base64url")}.c2lnbmF0dXJlc2lnbmF0dXJl`;
    s.tool(secrets(`TOKEN=${jwt}\n`)); fails(run(s), /llm.env: holds one of our own logins/);
  });
  withServer({}, (s) => {
    s.put(`workspaces/${OTHER}/tools/secrets/sa.json`, JSON.stringify({ private_key_id: "otherclientkeyid0123456789" }));
    s.tool(secrets("GOOGLE_KEY_ID=otherclientkeyid0123456789\n")); fails(run(s), /llm.env: holds a secret from elsewhere/);
  });
  withServer({ clientMemory: "args --api zzMcpArgValue0123456789\n" }, (s) => {
    const p = join(s.data, "config.json"); const c = JSON.parse(readFileSync(p, "utf8"));
    c.mcpServers = { ours: { command: "x", args: ["--api", "zzMcpArgValue0123456789"] } }; writeFileSync(p, JSON.stringify(c));
    fails(run(s), /MEMORY.md: holds a secret from elsewhere/);
  });
  withServer({ clientMemory: "token here: oauthFromOurHome0123456789\n" }, (s) => {
    const cred = join(s.root, "credentials.json"); writeFileSync(cred, JSON.stringify({ claudeAiOauth: { refreshToken: "oauthFromOurHome0123456789" } }));
    fails(run(s, ["--server-secrets", cred]), /MEMORY.md: holds a secret from elsewhere/);
    fails(run(s, ["--server-secrets", join(s.root, "missing.json")]), /--server-secrets .* not found/);
  });
  withServer({}, (s) => {
    s.put("webhooks.json", JSON.stringify({ token: "widgetco-proj-SECRETVALUE99" }));
    s.tool(secrets("KEY=widgetco-proj-SECRETVALUE99\n"));
    fails(run(s, ["--allow-in-secrets", "widgetco-proj"]), /llm.env: holds a secret from elsewhere/);
  });
});

test("embedded text in media and allowed binaries is checked; attachments used elsewhere stay behind", () => {
  const png = (text) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from([0, 0, 0, 20]), Buffer.from(`tEXt${text}`, "latin1"), Buffer.from([0xff, 0xfe, 0x00, 0x81])]);
  withServer({}, (s) => { s.put(`attachments/${ATT}`, png("Comment\0widgetco invoice RM50k")); fails(run(s), /png \(embedded text\): other-client text/); });
  withServer({}, (s) => { s.put(`attachments/${ATT}`, png("Comment\0a lovely studio photo")); ok(run(s)); });
  withServer({}, (s) => {
    s.put(`workspaces/${CLIENT}/blob.bin`, Buffer.concat([Buffer.from([0xff, 0xfe, 0x00, 0x81]), Buffer.from(OTHER)]));
    fails(run(s, ["--allow-binary", `workspaces/${CLIENT}/blob.bin`]), /blob.bin: another bot's/);
  });
  withServer({}, (s) => { s.editBots((b) => { b[1].avatarUrl = `/attachments/${ATT}`; }); fails(run(s), new RegExp(`attachment ${ATT}: also used by another bot`)); });
  withServer({}, (s) => {
    const d = new DatabaseSync(join(s.data, "messages.db"));
    d.prepare("INSERT INTO chat_followups VALUES ('f2', 'channel', 'group-y', 't-other-main', null, 'open', ?)").run(JSON.stringify({ file: ATT }));
    d.close();
    fails(run(s), /also used by another bot, a room or a followup/);
  });
});

test("server secrets behind links, inside json pems, in webhook urls and short env passwords are all caught", () => {
  const PEM_LINE = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7Zq8xP2mVt7LwR4nB9cYh";
  const cases = [
    ["linked.json", (root) => { writeFileSync(join(root, "real.json"), JSON.stringify({ refreshToken: "oauthBehindALink0123456789" })); symlinkSync(join(root, "real.json"), join(root, "linked.json")); }, "oauthBehindALink0123456789", "--server-secrets"],
    ["sa", (root) => { mkdirSync(join(root, "sa")); writeFileSync(join(root, "sa/key.json"), JSON.stringify({ private_key: `-----BEGIN PRIVATE KEY-----\n${PEM_LINE}\n-----END PRIVATE KEY-----\n` })); }, PEM_LINE, "--server-secrets"],
    [".env", (root) => writeFileSync(join(root, ".env"), "SLACK_URL=https://hooks.chat.example/services/T0AB12CD3/B0EF45GH6/aB3dE5fG7hJ9kL1mN3pQ5rS7\n"), "https://hooks.chat.example/services/T0AB12CD3/B0EF45GH6/aB3dE5fG7hJ9kL1mN3pQ5rS7", "--server-env"],
    [".env", (root) => writeFileSync(join(root, ".env"), "DB_PASSWORD=Xk9mQ2vR7tLp  # prod\n"), "Xk9mQ2vR7tLp", "--server-env"],
  ];
  for (const [name, make, value, flag] of cases) {
    withServer({ clientMemory: `remember ${value} ok\n` }, (s) => { make(s.root); fails(run(s, [flag, join(s.root, name)]), /MEMORY.md: holds a secret from elsewhere/); });
  }
  withServer({ clientMemory: "see https://oauth2.googleapis.com/token and 2026-10-17\n" }, (s) => {
    writeFileSync(join(s.root, ".env"), "TOKEN_URL=https://oauth2.googleapis.com/token\nSESSION_DATE=2026-10-17\n");
    ok(run(s, ["--server-env", join(s.root, ".env")]));
  });
});

test("accented, cjk and short names in image metadata are checked", () => {
  const png = (body) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(body), Buffer.from([0xff, 0xfe, 0x00, 0x81])]);
  for (const meta of ["iTXt\0<dc:creator>Zénith</dc:creator>", "iTXt\0<dc:creator>李明</dc:creator>", "tEXtAuthor\0acme\0"]) {
    withServer({}, (s) => { s.put(`attachments/${ATT}`, png(meta)); fails(run(s), /png \(embedded text\): other-client text/); });
  }
});
