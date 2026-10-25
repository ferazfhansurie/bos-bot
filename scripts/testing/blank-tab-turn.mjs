// The fixture bot's turn, done for real (FAKE_CLAUDE_TURN_COMMAND): a real
// `claude -p` gets this turn's message, BOS's own system prompt (so the
// bundled skills it picked, blank-tab included) and only the agents MCP
// server, so open_tab goes through the real proxy, endpoint and broadcast.
// Turns of one conversation share a claude session, like a real bot's.
// Evidence for the verifier goes to $FAKE_CLAUDE_TURN_EVIDENCE/turns.jsonl.
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const evidence = process.env.FAKE_CLAUDE_TURN_EVIDENCE;
const prompt = fs.readFileSync(process.env.FAKE_TURN_PROMPT, 'utf8');
const system = process.env.FAKE_TURN_SYSTEM_PROMPT ? fs.readFileSync(process.env.FAKE_TURN_SYSTEM_PROMPT, 'utf8') : '';
const config = JSON.parse(fs.readFileSync(process.env.FAKE_TURN_MCP_CONFIG, 'utf8'));
const agents = config.mcpServers?.agents;
// other verifiers reuse this turn with their own skill and tools (verify-desks)
const skillId = process.env.FAKE_CLAUDE_TURN_SKILL || 'blank-tab';
const allowed = process.env.FAKE_CLAUDE_TURN_TOOLS || 'Read,Write,Edit,Glob,Grep,mcp__agents__open_tab,mcp__agents__apps_list,mcp__agents__app_create,mcp__agents__app_read,mcp__agents__app_write';
const skills = [...system.matchAll(/<openmaus-skill id="([^"]+)"/g)].map(m => m[1]);
const record = {prompt, skill: skills.includes(skillId), skills, agentsServer: Boolean(agents), cwd: process.cwd()};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blank-tab-turn-'));
const mcp = path.join(tmp, 'mcp.json');
fs.writeFileSync(mcp, JSON.stringify({mcpServers: {agents}}));
fs.writeFileSync(path.join(evidence, 'mcp-shape.json'), JSON.stringify(agents && {...agents, env: Object.keys(agents.env ?? {})}, null, 2));
const sys = path.join(tmp, 'system.md');
fs.writeFileSync(sys, system);
const stateFile = path.join(evidence, 'claude-session');
const resume = fs.existsSync(stateFile) ? fs.readFileSync(stateFile, 'utf8').trim() : '';
const session = resume || randomUUID();
if (!resume) fs.writeFileSync(stateFile, session);
const n = fs.existsSync(path.join(evidence, 'turns.jsonl')) ? fs.readFileSync(path.join(evidence, 'turns.jsonl'), 'utf8').trim().split('\n').filter(Boolean).length + 1 : 1;

// The fixture's hermetic HOME/XDG/TMP would sign claude out: those come
// from the person running the verifier (FAKE_CLAUDE_TURN_ENV), the rest
// (the agents server's own wiring) stays the fixture's.
const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(XDG_|CLAUDE|TEMP$|TMP$|TMPDIR$|USERPROFILE$|APPDATA$|LOCALAPPDATA$|ELECTRON_RUN_AS_NODE$)/.test(k)));
const env = {...base, ...JSON.parse(process.env.FAKE_CLAUDE_TURN_ENV || '{}')};
const log = fs.openSync(path.join(evidence, `claude-${n}.log`), 'w');
const args = ['-p', prompt, ...(resume ? ['--resume', session] : ['--session-id', session]),
  '--append-system-prompt-file', sys, '--mcp-config', mcp, '--strict-mcp-config',
  '--setting-sources', 'project', '--permission-mode', 'acceptEdits', '--allowedTools', allowed,
  '--output-format', 'text', ...(process.env.FAKE_CLAUDE_TURN_DEBUG ? ['--debug', 'mcp'] : [])];
let out = '';
const child = spawn(process.env.FAKE_CLAUDE_TURN_CLAUDE || 'claude', args, {cwd: process.cwd(), env, stdio: ['ignore', 'pipe', log]});
child.stdout.on('data', chunk => { out += chunk; fs.writeSync(log, chunk); });
child.on('exit', code => {
  fs.closeSync(log);
  fs.rmSync(tmp, {recursive: true, force: true});
  fs.appendFileSync(path.join(evidence, 'turns.jsonl'), JSON.stringify({...record, n, code, reply: out.trim()}) + '\n');
  process.stdout.write((out.trim() || 'done') + '\n');
  process.exit(code ?? 1);
});
