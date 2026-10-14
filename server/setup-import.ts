// "Bring your setup": find an existing Claude Code, Codex or Cursor setup on
// this machine and import it into a bot through the stores BOS already has.
//
//   instructions (CLAUDE.md / AGENTS.md / cursor rules) -> the bot's SOUL
//   skills (<home>/skills/<name>/SKILL.md)            -> skills.ts installSkill
//   mcp servers (~/.claude.json, settings.json, .mcp.json, config.toml,
//                ~/.cursor/mcp.json)                  -> config.json mcpServers
//   projects (claude/codex project folders)           -> the bot's working folder
//
// Detection is read-only and never returns a secret: MCP env and header
// values stay on the server; the renderer sees their NAMES and a
// needs-sign-in flag. Hooks, plugins, subagents, slash commands and chat
// history are counted so the person knows they exist, but not imported.
//
// "Keep in sync" records what each import wrote. A changed source file is
// re-applied only while the bot's copy still matches what the import wrote;
// when both sides changed the link records a conflict and nothing is
// overwritten until the person picks a side.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { BOT_PROFILE_LIMITS } from "../shared/bot-profile.ts";
import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import {
  mcpServerNameError,
  parseMcpServerMutation,
  MAX_MCP_SERVERS,
  type StoredMcpServer,
} from "./mcp-registry.ts";
import {
  installSkill,
  listSkills,
  parseSkillMd,
  removeSkill,
  scanSkillText,
  setSkillEnabled,
  SKILL_FILE_MAX_BYTES,
} from "./skills.ts";

export type SetupSourceId = "claude" | "codex" | "cursor";
export const SETUP_SOURCES: readonly SetupSourceId[] = ["claude", "codex", "cursor"];

const TEXT_MAX_BYTES = 1024 * 1024;
const MAX_PROJECTS = 25;
const MAX_SKILLS = 200;
const MAX_SUPPORT_FILES = 40;
const IMPORT_DEPTH = 4;

// ── wire shapes (what the renderer sees; never a secret value) ─────────

export interface DetectedInstructions {
  files: string[];
  bytes: number;
  /** First lines, secrets redacted by the caller. */
  preview: string;
  /** @imports were expanded inline. */
  expanded: boolean;
  /** Over the bot's instruction limit even without expanding imports. */
  tooLong: boolean;
}

export interface DetectedSkill {
  name: string;
  description: string;
  path: string;
  error?: string;
  warnings: string[];
  supportFiles: number;
}

export interface DetectedMcpServer {
  id: string;
  /** The name it will get in BOS (slugged). */
  name: string;
  originalName: string;
  /** "user" or the project folder it belongs to. */
  scope: string;
  transport: "stdio" | "http" | "sse";
  /** Command or URL, for recognition. Arguments are not shown. */
  target: string;
  envKeys: string[];
  headerKeys: string[];
  needsSignIn: boolean;
  signInReasons: string[];
  /** Turned off in the source tool itself. */
  disabledInSource: boolean;
  /** Could not be stored as a BOS server. */
  error?: string;
}

export interface DetectedProject {
  path: string;
  name: string;
}

export interface DetectedSource {
  id: SetupSourceId;
  label: string;
  home: string;
  found: boolean;
  instructions: DetectedInstructions | null;
  skills: DetectedSkill[];
  mcpServers: DetectedMcpServer[];
  projects: DetectedProject[];
  /** Present in the source, not imported by BOS. */
  extras: { hooks: number; plugins: number; agents: number; commands: number; settings: boolean };
}

// ── small readers ──────────────────────────────────────────────────────

function home(): string {
  // An explicit override exists for isolated verification fixtures only.
  return process.env.OMB_SETUP_IMPORT_HOME || homedir();
}

function readText(path: string, max = TEXT_MAX_BYTES): string | null {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > max) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function readJson(path: string): Record<string, unknown> | null {
  const text = readText(path, 32 * 1024 * 1024);
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function listDir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function mtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record(value) ?? {})) {
    if (typeof entry === "string") out[key] = entry;
    else if (typeof entry === "number" || typeof entry === "boolean") out[key] = String(entry);
  }
  return out;
}

// ── a TOML subset, enough for codex mcp_servers and projects ──────────

type TomlValue = string | number | boolean | TomlValue[] | { [key: string]: TomlValue };

function parseTomlKeyPath(raw: string): string[] {
  const keys: string[] = [];
  let i = 0;
  while (i < raw.length) {
    while (raw[i] === " " || raw[i] === "\t") i += 1;
    if (raw[i] === '"' || raw[i] === "'") {
      const quote = raw[i]!;
      let j = i + 1;
      let key = "";
      while (j < raw.length && raw[j] !== quote) {
        if (quote === '"' && raw[j] === "\\" && j + 1 < raw.length) {
          key += raw[j + 1];
          j += 2;
          continue;
        }
        key += raw[j];
        j += 1;
      }
      keys.push(key);
      i = j + 1;
    } else {
      let j = i;
      while (j < raw.length && raw[j] !== "." && raw[j] !== " " && raw[j] !== "\t") j += 1;
      keys.push(raw.slice(i, j));
      i = j;
    }
    while (raw[i] === " " || raw[i] === "\t") i += 1;
    if (raw[i] === ".") i += 1;
  }
  return keys.filter((key) => key.length > 0);
}

/** Parse one value starting at `i`; returns the value and the index after it. */
function parseTomlValue(text: string, start: number): [TomlValue, number] {
  let i = start;
  const skip = () => {
    for (;;) {
      while (i < text.length && /\s/.test(text[i]!)) i += 1;
      if (text[i] === "#") {
        while (i < text.length && text[i] !== "\n") i += 1;
        continue;
      }
      break;
    }
  };
  skip();
  const ch = text[i];
  if (ch === '"' || ch === "'") {
    const triple = text.startsWith(ch.repeat(3), i);
    const close = triple ? ch.repeat(3) : ch;
    i += close.length;
    let out = "";
    while (i < text.length && !text.startsWith(close, i)) {
      if (ch === '"' && text[i] === "\\" && i + 1 < text.length) {
        const next = text[i + 1]!;
        out += next === "n" ? "\n" : next === "t" ? "\t" : next === "r" ? "\r" : next;
        i += 2;
        continue;
      }
      out += text[i];
      i += 1;
    }
    return [out, i + close.length];
  }
  if (ch === "[") {
    i += 1;
    const items: TomlValue[] = [];
    for (;;) {
      skip();
      if (text[i] === "]" || i >= text.length) return [items, i + 1];
      const [value, next] = parseTomlValue(text, i);
      items.push(value);
      i = next;
      skip();
      if (text[i] === ",") i += 1;
    }
  }
  if (ch === "{") {
    i += 1;
    const table: Record<string, TomlValue> = {};
    for (;;) {
      skip();
      if (text[i] === "}" || i >= text.length) return [table, i + 1];
      const eq = text.indexOf("=", i);
      if (eq < 0) return [table, text.length];
      const keys = parseTomlKeyPath(text.slice(i, eq).trim());
      const [value, next] = parseTomlValue(text, eq + 1);
      if (keys.length) setPath(table, keys, value);
      i = next;
      skip();
      if (text[i] === ",") i += 1;
    }
  }
  let j = i;
  while (j < text.length && !/[,\]\}\n#]/.test(text[j]!)) j += 1;
  const bare = text.slice(i, j).trim();
  if (bare === "true") return [true, j];
  if (bare === "false") return [false, j];
  const number = Number(bare.replaceAll("_", ""));
  return [Number.isFinite(number) && bare !== "" ? number : bare, j];
}

function setPath(root: Record<string, TomlValue>, keys: string[], value: TomlValue): void {
  let node = root;
  for (const key of keys.slice(0, -1)) {
    const existing = node[key];
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) node[key] = {};
    node = node[key] as Record<string, TomlValue>;
  }
  node[keys[keys.length - 1]!] = value;
}

/** Tables and key/value rows; array-of-tables headers are skipped. */
export function parseToml(text: string): Record<string, TomlValue> {
  const root: Record<string, TomlValue> = {};
  let table: string[] = [];
  let i = 0;
  while (i < text.length) {
    const lineEnd = text.indexOf("\n", i) === -1 ? text.length : text.indexOf("\n", i);
    const line = text.slice(i, lineEnd).trim();
    if (!line || line.startsWith("#")) {
      i = lineEnd + 1;
      continue;
    }
    if (line.startsWith("[[")) {
      table = ["__array_table__"];
      i = lineEnd + 1;
      continue;
    }
    if (line.startsWith("[")) {
      const close = line.lastIndexOf("]");
      table = parseTomlKeyPath(line.slice(1, close > 0 ? close : undefined));
      i = lineEnd + 1;
      continue;
    }
    const eq = text.indexOf("=", i);
    if (eq < 0 || eq > lineEnd) {
      i = lineEnd + 1;
      continue;
    }
    const keys = parseTomlKeyPath(text.slice(i, eq).trim());
    const [value, next] = parseTomlValue(text, eq + 1);
    if (keys.length && table[0] !== "__array_table__") setPath(root, [...table, ...keys], value);
    const after = text.indexOf("\n", next);
    i = after === -1 ? text.length : after + 1;
  }
  return root;
}

// ── instructions ───────────────────────────────────────────────────────

const IMPORT_LINE = /^\s*@((?:~|\.{1,2})?\/?[^\s@]+)\s*$/;

/** Claude Code's `@path` imports, expanded inline when a line is only an
 * import. Every file read is returned so sync can watch all of them. */
function expandImports(path: string, depth: number, seen: Set<string>, files: string[]): string | null {
  const text = readText(path);
  if (text === null) return null;
  seen.add(path);
  files.push(path);
  if (depth >= IMPORT_DEPTH) return text;
  return text
    .split("\n")
    .map((line) => {
      const match = IMPORT_LINE.exec(line);
      if (!match) return line;
      const raw = match[1]!;
      const target = raw.startsWith("~/") ? join(home(), raw.slice(2)) : isAbsolute(raw) ? raw : resolve(dirname(path), raw);
      if (seen.has(target) || !/\.(md|mdc|txt)$/i.test(target)) return line;
      const nested = expandImports(target, depth + 1, seen, files);
      return nested === null ? line : nested.trimEnd();
    })
    .join("\n");
}

interface InstructionPlan {
  candidates: string[];
  expand: boolean;
}

function instructionPlan(source: SetupSourceId): InstructionPlan {
  const h = home();
  if (source === "claude") {
    return { candidates: [join(h, ".claude", "CLAUDE.md"), join(h, "CLAUDE.md")], expand: true };
  }
  if (source === "codex") {
    const override = join(h, ".codex", "AGENTS.override.md");
    return { candidates: [existsSync(override) ? override : join(h, ".codex", "AGENTS.md")], expand: false };
  }
  const rulesDir = join(h, ".cursor", "rules");
  const rules = listDir(rulesDir)
    .filter((name) => /\.(md|mdc)$/i.test(name))
    .sort()
    .map((name) => join(rulesDir, name));
  return { candidates: [...rules, join(h, ".cursor", "AGENTS.md")], expand: false };
}

/** Strip cursor rule frontmatter; it is metadata, not instructions. */
function stripFrontmatter(text: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

export interface ReadInstructions {
  text: string;
  files: string[];
  expanded: boolean;
}

/** The instructions as they would be imported. Expanded when that fits the
 * bot's limit; otherwise the raw files with their `@` references intact. */
export function readInstructions(source: SetupSourceId, preferExpanded = true): ReadInstructions | null {
  const plan = instructionPlan(source);
  const present = plan.candidates.filter((path) => readText(path) !== null);
  if (!present.length) return null;
  const build = (expand: boolean): ReadInstructions => {
    const files: string[] = [];
    const parts: string[] = [];
    for (const path of present) {
      const text = expand ? expandImports(path, 0, new Set(), files) : (files.push(path), readText(path));
      if (text === null) continue;
      const body = source === "cursor" ? stripFrontmatter(text) : text;
      if (body.trim()) parts.push(body.trim());
    }
    return { text: parts.join("\n\n"), files: [...new Set(files)], expanded: expand };
  };
  if (plan.expand && preferExpanded) {
    const expanded = build(true);
    if (Buffer.byteLength(expanded.text, "utf8") <= BOT_PROFILE_LIMITS.soul && expanded.files.length > present.length) {
      return expanded;
    }
  }
  const raw = build(false);
  return raw.text ? raw : null;
}

// ── skills ─────────────────────────────────────────────────────────────

function skillRoots(source: SetupSourceId): string[] {
  const h = home();
  if (source === "claude") return [join(h, ".claude", "skills")];
  if (source === "codex") return [join(h, ".codex", "skills"), join(h, ".agents", "skills")];
  // ~/.cursor/skills-cursor holds Cursor's own bundled skills, not the user's.
  return [join(h, ".cursor", "skills")];
}

function supportFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string, prefix: string, depth: number) => {
    if (depth > 3 || out.length >= MAX_SUPPORT_FILES) return;
    for (const name of listDir(current)) {
      if (out.length >= MAX_SUPPORT_FILES) return;
      if (name.startsWith(".") || (depth === 0 && name === "SKILL.md")) continue;
      const path = join(current, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (isDir(path)) walk(path, rel, depth + 1);
      else out.push(rel);
    }
  };
  walk(dir, "", 0);
  return out;
}

interface SkillOnDisk extends DetectedSkill {
  text: string | null;
}

function scanSkills(source: SetupSourceId): SkillOnDisk[] {
  const out: SkillOnDisk[] = [];
  const names = new Set<string>();
  for (const root of skillRoots(source)) {
    for (const entry of listDir(root).sort()) {
      if (out.length >= MAX_SKILLS) break;
      if (entry.startsWith(".")) continue;
      const dir = join(root, entry);
      const file = join(dir, "SKILL.md");
      const text = readText(file, SKILL_FILE_MAX_BYTES);
      if (text === null) continue;
      const parsed = parseSkillMd(text);
      const name = "error" in parsed ? entry : parsed.name;
      if (names.has(name)) continue;
      names.add(name);
      out.push({
        name,
        description: "error" in parsed ? "" : parsed.description,
        path: dir,
        ...("error" in parsed ? { error: parsed.error } : {}),
        warnings: scanSkillText(text),
        supportFiles: supportFiles(dir).length,
        text,
      });
    }
  }
  return out;
}

function readSkillDir(dir: string): { text: string; files: Array<{ path: string; content: string }> } | null {
  const text = readText(join(dir, "SKILL.md"), SKILL_FILE_MAX_BYTES);
  if (text === null) return null;
  // Supporting files are named, not copied: skills.ts v1 imports SKILL.md only
  // and lists the rest on the review surface.
  return {
    text,
    files: [{ path: "SKILL.md", content: text }, ...supportFiles(dir).map((path) => ({ path, content: "" }))],
  };
}

// ── mcp servers ────────────────────────────────────────────────────────

interface McpOnDisk {
  detected: DetectedMcpServer;
  spec: Record<string, unknown> | null;
}

const PLACEHOLDER = /\$\{[^}]+\}|^\$[A-Za-z_]\w*$/;

function slugName(raw: string): string {
  const slug = raw.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
  return /^[a-z]/.test(slug) ? slug : slug ? `mcp-${slug}`.slice(0, 32) : "mcp";
}

function claudeNeedsAuth(): Set<string> {
  const cache = readJson(join(home(), ".claude", "mcp-needs-auth-cache.json"));
  return new Set(Object.keys(cache ?? {}));
}

function describeServer(
  source: SetupSourceId,
  scope: string,
  originalName: string,
  raw: Record<string, unknown>,
  extra: { authNames?: Set<string>; envNames?: string[]; bearerEnv?: string; disabled?: boolean } = {},
): McpOnDisk {
  const reasons: string[] = [];
  const url = typeof raw.url === "string" ? raw.url : typeof raw.serverUrl === "string" ? raw.serverUrl : "";
  const remote = Boolean(url) || raw.type === "http" || raw.type === "sse" || raw.type === "streamable-http";
  const env = stringMap(raw.env);
  const headers = stringMap(raw.headers ?? raw.http_headers);
  const args = Array.isArray(raw.args) ? raw.args.filter((arg): arg is string => typeof arg === "string") : [];
  for (const [key, value] of Object.entries({ ...env, ...headers })) {
    if (!value.trim() || PLACEHOLDER.test(value)) reasons.push(`set ${key}`);
  }
  for (const name of extra.envNames ?? []) reasons.push(`set ${name}`);
  if (extra.bearerEnv) reasons.push(`set ${extra.bearerEnv}`);
  if (remote && !Object.keys(headers).length && !extra.bearerEnv) reasons.push("sign in with oauth");
  if (!remote && args.some((arg) => /mcp-remote/.test(arg))) reasons.push("sign in with oauth");
  if (extra.authNames?.has(originalName)) reasons.push("sign-in expired in the source tool");
  const transport: DetectedMcpServer["transport"] = remote ? (raw.type === "sse" ? "sse" : "http") : "stdio";
  const spec: Record<string, unknown> | null = remote
    ? { type: transport, url, headers }
    : typeof raw.command === "string" && raw.command
      ? { command: raw.command, args, env }
      : null;
  const name = slugName(originalName);
  const parsed = spec ? parseMcpServerMutation(name, spec) : { ok: false as const, error: "no command or url" };
  const id = sha(`${source}\0${scope}\0${originalName}`).slice(0, 12);
  return {
    detected: {
      id,
      name,
      originalName,
      scope,
      transport,
      target: remote ? url : String(raw.command ?? ""),
      envKeys: [...new Set([...Object.keys(env), ...(extra.envNames ?? []), ...(extra.bearerEnv ? [extra.bearerEnv] : [])])].sort(),
      headerKeys: Object.keys(headers).sort(),
      needsSignIn: reasons.length > 0,
      signInReasons: [...new Set(reasons)],
      disabledInSource: extra.disabled === true || raw.enabled === false || raw.disabled === true,
      ...(parsed.ok ? {} : { error: parsed.error }),
    },
    spec: parsed.ok ? spec : null,
  };
}

function mcpMap(value: unknown): Array<[string, Record<string, unknown>]> {
  return Object.entries(record(value) ?? {}).flatMap(([name, entry]) => {
    const r = record(entry);
    return r ? [[name, r] as [string, Record<string, unknown>]] : [];
  });
}

function claudeProjects(): Array<{ path: string; at: number; mcp: unknown }> {
  const json = readJson(join(home(), ".claude.json"));
  const projects = record(json?.projects) ?? {};
  return Object.entries(projects).flatMap(([path, value]) => {
    if (!isAbsolute(path) || path === home() || !isDir(path)) return [];
    const encoded = path.replace(/[^A-Za-z0-9]/g, "-");
    return [{ path, at: mtime(join(home(), ".claude", "projects", encoded)) || mtime(path), mcp: record(value)?.mcpServers }];
  });
}

function scanMcp(source: SetupSourceId, projectLimit: DetectedProject[]): McpOnDisk[] {
  const h = home();
  const out: McpOnDisk[] = [];
  if (source === "claude") {
    const auth = claudeNeedsAuth();
    const json = readJson(join(h, ".claude.json"));
    const settings = readJson(join(h, ".claude", "settings.json"));
    for (const [name, raw] of [...mcpMap(json?.mcpServers), ...mcpMap(settings?.mcpServers)]) {
      out.push(describeServer(source, "user", name, raw, { authNames: auth }));
    }
    const projects = new Map(claudeProjects().map((project) => [project.path, project]));
    for (const project of projectLimit) {
      for (const [name, raw] of mcpMap(projects.get(project.path)?.mcp)) {
        out.push(describeServer(source, project.path, name, raw, { authNames: auth }));
      }
      for (const [name, raw] of mcpMap(readJson(join(project.path, ".mcp.json"))?.mcpServers)) {
        out.push(describeServer(source, project.path, name, raw, { authNames: auth }));
      }
    }
  } else if (source === "codex") {
    const text = readText(join(h, ".codex", "config.toml"));
    const toml = text ? parseToml(text) : {};
    for (const [name, raw] of mcpMap(toml.mcp_servers)) {
      const envNames = Array.isArray(raw.env_vars) ? raw.env_vars.filter((v): v is string => typeof v === "string") : [];
      const headerEnv = stringMap(raw.env_http_headers);
      out.push(describeServer(source, "user", name, raw, {
        envNames: [...envNames, ...Object.values(headerEnv)],
        bearerEnv: typeof raw.bearer_token_env_var === "string" ? raw.bearer_token_env_var : undefined,
      }));
    }
  } else {
    for (const [name, raw] of mcpMap(readJson(join(h, ".cursor", "mcp.json"))?.mcpServers)) {
      out.push(describeServer(source, "user", name, raw));
    }
  }
  // The same server listed twice (user + project, or both claude files) is
  // one row; a different server under a taken name gets a numbered name.
  const seen = new Map<string, string>();
  const unique: McpOnDisk[] = [];
  for (const entry of out) {
    const fingerprint = JSON.stringify(entry.spec ?? entry.detected.target);
    const previous = seen.get(entry.detected.name);
    if (previous === fingerprint) continue;
    if (previous !== undefined) {
      let n = 2;
      while (seen.has(`${entry.detected.name.slice(0, 29)}-${n}`)) n += 1;
      entry.detected.name = `${entry.detected.name.slice(0, 29)}-${n}`;
    }
    seen.set(entry.detected.name, fingerprint);
    unique.push(entry);
  }
  return unique;
}

// ── projects + extras ──────────────────────────────────────────────────

function scanProjects(source: SetupSourceId): DetectedProject[] {
  let entries: Array<{ path: string; at: number }> = [];
  if (source === "claude") entries = claudeProjects();
  if (source === "codex") {
    const text = readText(join(home(), ".codex", "config.toml"));
    const projects = record(text ? parseToml(text).projects : null) ?? {};
    entries = Object.keys(projects)
      .filter((path) => isAbsolute(path) && path !== home() && !path.startsWith("/private/tmp") && isDir(path))
      .map((path) => ({ path, at: mtime(path) }));
  }
  return entries
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_PROJECTS)
    .map(({ path }) => ({ path, name: basename(path) }));
}

function countFiles(dir: string, pattern: RegExp): number {
  return listDir(dir).filter((name) => pattern.test(name)).length;
}

function scanExtras(source: SetupSourceId): DetectedSource["extras"] {
  const h = home();
  if (source === "claude") {
    const settings = readJson(join(h, ".claude", "settings.json"));
    const hooks = Object.values(record(settings?.hooks) ?? {}).reduce<number>(
      (sum, value) => sum + (Array.isArray(value) ? value.length : 0), 0,
    );
    const installed = record(readJson(join(h, ".claude", "plugins", "installed_plugins.json"))?.plugins) ?? {};
    return {
      hooks,
      plugins: Object.keys(installed).length,
      agents: countFiles(join(h, ".claude", "agents"), /\.md$/),
      commands: countFiles(join(h, ".claude", "commands"), /\.md$/),
      settings: settings !== null,
    };
  }
  if (source === "codex") {
    const hooks = readJson(join(h, ".codex", "hooks.json"));
    const hookCount = Object.values(record(hooks?.hooks) ?? hooks ?? {}).reduce<number>(
      (sum, value) => sum + (Array.isArray(value) ? value.length : 0), 0,
    );
    return {
      hooks: hookCount,
      plugins: listDir(join(h, ".codex", "plugins")).filter((name) => !name.startsWith(".") && name !== "cache").length,
      agents: 0,
      commands: countFiles(join(h, ".codex", "prompts"), /\.md$/),
      settings: existsSync(join(h, ".codex", "config.toml")),
    };
  }
  return { hooks: 0, plugins: 0, agents: 0, commands: 0, settings: existsSync(join(h, ".cursor", "cli-config.json")) };
}

const LABELS: Record<SetupSourceId, string> = { claude: "claude code", codex: "codex", cursor: "cursor" };
const HOMES: Record<SetupSourceId, string> = { claude: ".claude", codex: ".codex", cursor: ".cursor" };

interface FullScan {
  source: DetectedSource;
  skills: SkillOnDisk[];
  mcp: McpOnDisk[];
}

function scan(id: SetupSourceId, redact: (text: string) => string): FullScan {
  const root = join(home(), HOMES[id]);
  const found = isDir(root);
  if (!found) {
    return {
      source: {
        id, label: LABELS[id], home: root, found: false, instructions: null, skills: [], mcpServers: [], projects: [],
        extras: { hooks: 0, plugins: 0, agents: 0, commands: 0, settings: false },
      },
      skills: [],
      mcp: [],
    };
  }
  const instructions = readInstructions(id);
  const projects = scanProjects(id);
  const skills = scanSkills(id);
  const mcp = scanMcp(id, projects);
  const bytes = instructions ? Buffer.byteLength(instructions.text, "utf8") : 0;
  return {
    source: {
      id,
      label: LABELS[id],
      home: root,
      found: true,
      instructions: instructions
        ? {
          files: instructions.files,
          bytes,
          preview: redact(instructions.text.split("\n").slice(0, 12).join("\n")).slice(0, 1200),
          expanded: instructions.expanded,
          tooLong: bytes > BOT_PROFILE_LIMITS.soul,
        }
        : null,
      skills: skills.map(({ text: _text, ...skill }) => skill),
      mcpServers: mcp.map((entry) => entry.detected),
      projects,
      extras: scanExtras(id),
    },
    skills,
    mcp,
  };
}

export function detectSetups(redact: (text: string) => string): DetectedSource[] {
  return SETUP_SOURCES.map((id) => scan(id, redact).source);
}

// ── sync links ─────────────────────────────────────────────────────────

export interface SyncLink {
  id: string;
  source: SetupSourceId;
  botId: string;
  sync: boolean;
  createdAt: string;
  updatedAt: string;
  instructions?: {
    mode: "replace" | "append";
    /** The bot's instructions before an append import, kept to re-apply. */
    prefix: string;
    expanded: boolean;
    files: string[];
    sourceHash: string;
    /** Hash of the bot's instructions right after the last import. */
    botHash: string;
    /** The person kept BOS's version; every later source change asks. */
    diverged?: boolean;
  };
  skills: Record<string, { dir: string; sourceHash: string; installedSha: string }>;
  mtimes: Record<string, number>;
  conflicts: Array<{ kind: "instructions" | "skill"; name: string; at: string; reason: string }>;
  lastCheckedAt?: string;
}

interface LinkFile {
  version: 1;
  links: SyncLink[];
}

function linkPath(): string {
  return join(DATA_DIR, "setup-import.json");
}

export function readLinks(): SyncLink[] {
  const json = readJson(linkPath());
  return Array.isArray(json?.links) ? (json.links as SyncLink[]) : [];
}

function writeLinks(links: SyncLink[]): void {
  mkdirSync(DATA_DIR, { recursive: true });
  const file: LinkFile = { version: 1, links };
  writeFileAtomic(linkPath(), `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
}

function linkFiles(link: SyncLink): string[] {
  return [
    ...(link.instructions?.files ?? []),
    ...Object.values(link.skills).map((skill) => join(skill.dir, "SKILL.md")),
  ];
}

function snapshotMtimes(link: SyncLink): Record<string, number> {
  return Object.fromEntries(linkFiles(link).map((path) => [path, mtime(path)]));
}

// ── apply ──────────────────────────────────────────────────────────────

/** What the server hands this module: the existing write paths. */
export interface SetupImportDeps {
  bot(botId: string): { id: string; soul?: string; mcpServers?: string[] } | null;
  /** Validated soul and/or working folder write, recorded in profile history. */
  writeProfile(botId: string, patch: { soul?: string; cwd?: string }): { ok: true } | { ok: false; error: string };
  mcpConfig(): Record<string, unknown>;
  persistMcp(next: Record<string, unknown>): void;
  setBotMcpServers(botId: string, names: string[]): void;
  redact(text: string): string;
}

export const applyRequestShape = {
  sources: SETUP_SOURCES,
};

export interface ApplyRequest {
  source: SetupSourceId;
  botId: string;
  instructions: null | { mode: "replace" | "append" };
  skills: string[];
  mcpServers: string[];
  project: string | null;
  sync: boolean;
}

export interface ApplyItemResult {
  name: string;
  ok: boolean;
  enabled?: boolean;
  message: string;
}

export interface ApplyResult {
  instructions: ApplyItemResult | null;
  skills: ApplyItemResult[];
  mcpServers: ApplyItemResult[];
  project: ApplyItemResult | null;
  link: SyncLink | null;
}

function joinSoul(prefix: string, text: string): string {
  return prefix.trim() ? `${prefix.trimEnd()}\n\n${text}` : text;
}

function installFromDir(botId: string, source: SetupSourceId, dir: string): { listing: ReturnType<typeof listSkills>[number]; sourceHash: string; enabled: boolean } | { error: string } {
  const read = readSkillDir(dir);
  if (!read) return { error: "SKILL.md could not be read" };
  const installed = installSkill(botId, `local:${source}:${dir}`, read.files);
  if ("error" in installed) return installed;
  // The person already runs this skill in their own tool. Turn it on unless
  // the content scan found something to read first.
  let enabled = false;
  if (scanSkillText(read.text).length === 0) {
    const on = setSkillEnabled(botId, installed.name, true);
    enabled = !("error" in on) && on.enabled;
  }
  return { listing: installed, sourceHash: sha(read.text), enabled };
}

export function applySetupImport(deps: SetupImportDeps, request: ApplyRequest): ApplyResult | { error: string } {
  const bot = deps.bot(request.botId);
  if (!bot) return { error: "no such bot" };
  const full = scan(request.source, deps.redact);
  if (!full.source.found) return { error: `no ${LABELS[request.source]} setup found on this computer` };
  const result: ApplyResult = { instructions: null, skills: [], mcpServers: [], project: null, link: null };
  const now = new Date().toISOString();
  const links = readLinks();
  let link = links.find((candidate) => candidate.source === request.source && candidate.botId === request.botId);
  if (!link) {
    link = {
      id: randomUUID(), source: request.source, botId: request.botId, sync: false,
      createdAt: now, updatedAt: now, skills: {}, mtimes: {}, conflicts: [],
    };
  }

  // instructions + working folder go through one validated profile write
  const profile: { soul?: string; cwd?: string } = {};
  let instructionState: SyncLink["instructions"];
  if (request.instructions) {
    const read = readInstructions(request.source);
    if (!read) {
      result.instructions = { name: "instructions", ok: false, message: "no instructions file found" };
    } else {
      const prefix = request.instructions.mode === "append" ? (bot.soul ?? "") : "";
      const soul = joinSoul(prefix, read.text);
      if (Buffer.byteLength(soul, "utf8") > BOT_PROFILE_LIMITS.soul) {
        result.instructions = {
          name: "instructions", ok: false,
          message: `too long for a bot's instructions (${Math.ceil(Buffer.byteLength(soul, "utf8") / 1000)} kb, limit ${BOT_PROFILE_LIMITS.soul / 1000} kb)`,
        };
      } else {
        profile.soul = soul;
        instructionState = {
          mode: request.instructions.mode, prefix, expanded: read.expanded, files: read.files,
          sourceHash: sha(read.text), botHash: sha(soul),
        };
      }
    }
  }
  if (request.project) {
    const known = full.source.projects.some((project) => project.path === request.project);
    if (!known) result.project = { name: request.project, ok: false, message: "not one of this setup's projects" };
    else profile.cwd = request.project;
  }
  if (profile.soul !== undefined || profile.cwd !== undefined) {
    const written = deps.writeProfile(request.botId, profile);
    if (profile.soul !== undefined) {
      result.instructions = written.ok
        ? { name: "instructions", ok: true, message: request.instructions?.mode === "append" ? "added below the bot's instructions" : "replaced the bot's instructions" }
        : { name: "instructions", ok: false, message: written.error };
      if (written.ok) link.instructions = instructionState;
    }
    if (profile.cwd !== undefined) {
      result.project = written.ok
        ? { name: profile.cwd, ok: true, message: "set as the bot's working folder" }
        : { name: profile.cwd, ok: false, message: written.error };
    }
  }

  // skills: the same installer the github import uses
  const wanted = new Set(request.skills);
  for (const skill of full.skills.filter((candidate) => wanted.has(candidate.name))) {
    if (skill.error) {
      result.skills.push({ name: skill.name, ok: false, message: skill.error });
      continue;
    }
    const installed = installFromDir(request.botId, request.source, skill.path);
    if ("error" in installed) {
      result.skills.push({ name: skill.name, ok: false, message: installed.error });
      continue;
    }
    link.skills[installed.listing.name] = { dir: skill.path, sourceHash: installed.sourceHash, installedSha: installed.listing.sha256 };
    result.skills.push({
      name: installed.listing.name, ok: true, enabled: installed.enabled,
      message: installed.enabled ? "imported and on" : "imported, off until you review it",
    });
  }

  // mcp servers: the app-wide registry, scoped to the bot when it has a list
  const pickedMcp = new Set(request.mcpServers);
  const current = { ...deps.mcpConfig() };
  const added: string[] = [];
  for (const entry of full.mcp.filter((candidate) => pickedMcp.has(candidate.detected.id))) {
    const { detected, spec } = entry;
    if (!spec || detected.error) {
      result.mcpServers.push({ name: detected.name, ok: false, message: detected.error ?? "cannot be stored" });
      continue;
    }
    if (mcpServerNameError(detected.name)) {
      result.mcpServers.push({ name: detected.name, ok: false, message: mcpServerNameError(detected.name)! });
      continue;
    }
    const parsed = parseMcpServerMutation(detected.name, spec);
    if (!parsed.ok) {
      result.mcpServers.push({ name: detected.name, ok: false, message: parsed.error });
      continue;
    }
    const enabled = !detected.needsSignIn && !detected.disabledInSource;
    const server: StoredMcpServer = { ...parsed.server, enabled };
    if (Object.hasOwn(current, detected.name)) {
      const { enabled: _a, ...existing } = record(current[detected.name]) ?? {};
      const { enabled: _b, ...incoming } = server as unknown as Record<string, unknown>;
      if (JSON.stringify(existing) === JSON.stringify(incoming)) {
        added.push(detected.name);
        result.mcpServers.push({ name: detected.name, ok: true, message: "already in bos" });
      } else {
        result.mcpServers.push({ name: detected.name, ok: false, message: "a different server already uses this name" });
      }
      continue;
    }
    if (Object.keys(current).length >= MAX_MCP_SERVERS) {
      result.mcpServers.push({ name: detected.name, ok: false, message: `bos holds at most ${MAX_MCP_SERVERS} mcp servers` });
      continue;
    }
    current[detected.name] = server;
    added.push(detected.name);
    result.mcpServers.push({
      name: detected.name, ok: true, enabled,
      message: enabled ? "added and on" : detected.needsSignIn ? `added off: ${detected.signInReasons.join(", ")}` : "added off, as in the source",
    });
  }
  if (result.mcpServers.some((entry) => entry.ok && entry.message !== "already in bos")) deps.persistMcp(current);
  if (added.length && Array.isArray(bot.mcpServers)) {
    deps.setBotMcpServers(request.botId, [...new Set([...bot.mcpServers, ...added])].slice(0, MAX_MCP_SERVERS));
  }

  // remember what was written so sync can tell later edits apart
  const tracked = Boolean(link.instructions) || Object.keys(link.skills).length > 0;
  if (tracked) {
    link.sync = request.sync;
    link.updatedAt = now;
    link.mtimes = snapshotMtimes(link);
    link.conflicts = link.conflicts.filter((conflict) =>
      conflict.kind === "instructions" ? !request.instructions : !wanted.has(conflict.name));
    const others = links.filter((candidate) => candidate.id !== link!.id);
    writeLinks([...others, link]);
    result.link = link;
    refreshWatchers?.();
  }
  return result;
}

// ── sync ───────────────────────────────────────────────────────────────

function addConflict(link: SyncLink, kind: "instructions" | "skill", name: string, reason: string): void {
  if (link.conflicts.some((conflict) => conflict.kind === kind && conflict.name === name)) return;
  link.conflicts.push({ kind, name, at: new Date().toISOString(), reason });
}

function dropConflict(link: SyncLink, kind: "instructions" | "skill", name: string): void {
  link.conflicts = link.conflicts.filter((conflict) => !(conflict.kind === kind && conflict.name === name));
}

function reapplyInstructions(deps: SetupImportDeps, link: SyncLink, force: boolean): "applied" | "conflict" | "unchanged" | "gone" {
  const state = link.instructions;
  if (!state) return "unchanged";
  const bot = deps.bot(link.botId);
  if (!bot) return "gone";
  const read = readInstructions(link.source, state.expanded);
  if (!read) return "unchanged";
  const sourceHash = sha(read.text);
  if (sourceHash === state.sourceHash && !force) {
    dropConflict(link, "instructions", "instructions");
    return "unchanged";
  }
  const botChanged = sha(bot.soul ?? "") !== state.botHash;
  if (!force && (state.diverged || botChanged)) {
    addConflict(link, "instructions", "instructions", "changed in both places");
    return "conflict";
  }
  const soul = joinSoul(state.prefix, read.text);
  if (Buffer.byteLength(soul, "utf8") > BOT_PROFILE_LIMITS.soul) {
    addConflict(link, "instructions", "instructions", "the source grew past the instruction limit");
    return "conflict";
  }
  const written = deps.writeProfile(link.botId, { soul });
  if (!written.ok) {
    addConflict(link, "instructions", "instructions", written.error);
    return "conflict";
  }
  link.instructions = { ...state, files: read.files, sourceHash, botHash: sha(soul), diverged: false };
  dropConflict(link, "instructions", "instructions");
  return "applied";
}

function reapplySkill(link: SyncLink, name: string, force: boolean): "applied" | "conflict" | "unchanged" | "gone" {
  const tracked = link.skills[name];
  if (!tracked) return "unchanged";
  const read = readSkillDir(tracked.dir);
  if (!read) return "unchanged";
  const sourceHash = sha(read.text);
  if (sourceHash === tracked.sourceHash && !force) {
    dropConflict(link, "skill", name);
    return "unchanged";
  }
  const installed = listSkills(link.botId).find((skill) => skill.name === name);
  if (!installed) {
    // removed in bos on purpose; stop following it
    delete link.skills[name];
    dropConflict(link, "skill", name);
    return "gone";
  }
  if (!force && installed.sha256 !== tracked.installedSha) {
    addConflict(link, "skill", name, "changed in both places");
    return "conflict";
  }
  const wasEnabled = installed.enabled;
  const removed = removeSkill(link.botId, name);
  if ("error" in removed) {
    addConflict(link, "skill", name, removed.error);
    return "conflict";
  }
  const again = installFromDir(link.botId, link.source, tracked.dir);
  if ("error" in again) {
    delete link.skills[name];
    addConflict(link, "skill", name, again.error);
    return "conflict";
  }
  if (!wasEnabled && again.enabled) setSkillEnabled(link.botId, again.listing.name, false);
  delete link.skills[name];
  link.skills[again.listing.name] = { dir: tracked.dir, sourceHash: again.sourceHash, installedSha: again.listing.sha256 };
  dropConflict(link, "skill", name);
  return "applied";
}

export interface SyncReport {
  applied: string[];
  conflicts: number;
}

/** Re-apply changed sources for every link with sync on. Cheap when nothing
 * moved: only file mtimes are read until one differs. */
export function checkSync(deps: SetupImportDeps, options: { force?: boolean } = {}): SyncReport {
  const links = readLinks();
  const report: SyncReport = { applied: [], conflicts: 0 };
  let dirty = false;
  const kept: SyncLink[] = [];
  for (const link of links) {
    if (!deps.bot(link.botId)) {
      dirty = true;
      continue;
    }
    kept.push(link);
    if (!link.sync) continue;
    const mtimes = snapshotMtimes(link);
    const moved = options.force || Object.entries(mtimes).some(([path, at]) => link.mtimes[path] !== at)
      // an @import added since the last read is a new file to watch
      || Object.keys(link.mtimes).length !== Object.keys(mtimes).length;
    if (!moved) continue;
    dirty = true;
    if (reapplyInstructions(deps, link, false) === "applied") report.applied.push(`instructions (${link.source})`);
    for (const name of Object.keys(link.skills)) {
      if (reapplySkill(link, name, false) === "applied") report.applied.push(`skill ${name}`);
    }
    link.mtimes = snapshotMtimes(link);
    link.lastCheckedAt = new Date().toISOString();
  }
  for (const link of kept) report.conflicts += link.conflicts.length;
  if (dirty) writeLinks(kept);
  return report;
}

export function setLinkSync(linkId: string, sync: boolean): SyncLink | null {
  const links = readLinks();
  const link = links.find((candidate) => candidate.id === linkId);
  if (!link) return null;
  link.sync = sync;
  link.updatedAt = new Date().toISOString();
  if (sync) link.mtimes = {};
  writeLinks(links);
  refreshWatchers?.();
  return link;
}

export function removeLink(linkId: string): boolean {
  const links = readLinks();
  const next = links.filter((candidate) => candidate.id !== linkId);
  if (next.length === links.length) return false;
  writeLinks(next);
  refreshWatchers?.();
  return true;
}

/** The person's answer to a conflict: take the source, or keep BOS's copy. */
export function resolveConflict(
  deps: SetupImportDeps,
  linkId: string,
  kind: "instructions" | "skill",
  name: string,
  keep: "source" | "bos",
): SyncLink | { error: string } {
  const links = readLinks();
  const link = links.find((candidate) => candidate.id === linkId);
  if (!link) return { error: "no such import" };
  if (kind === "instructions") {
    if (!link.instructions) return { error: "this import has no instructions" };
    if (keep === "source") {
      const outcome = reapplyInstructions(deps, link, true);
      if (outcome !== "applied") return { error: link.conflicts.find((c) => c.kind === "instructions")?.reason ?? "could not apply" };
    } else {
      const read = readInstructions(link.source, link.instructions.expanded);
      const bot = deps.bot(link.botId);
      link.instructions = {
        ...link.instructions,
        sourceHash: read ? sha(read.text) : link.instructions.sourceHash,
        botHash: sha(bot?.soul ?? ""),
        diverged: true,
      };
      dropConflict(link, "instructions", "instructions");
    }
  } else {
    const tracked = link.skills[name];
    if (!tracked) return { error: "this import does not follow that skill" };
    if (keep === "source") {
      const outcome = reapplySkill(link, name, true);
      if (outcome === "conflict") return { error: link.conflicts.find((c) => c.name === name)?.reason ?? "could not apply" };
    } else {
      const read = readSkillDir(tracked.dir);
      const installed = listSkills(link.botId).find((skill) => skill.name === name);
      link.skills[name] = {
        ...tracked,
        sourceHash: read ? sha(read.text) : tracked.sourceHash,
        installedSha: installed?.sha256 ?? tracked.installedSha,
      };
      dropConflict(link, "skill", name);
    }
  }
  link.mtimes = snapshotMtimes(link);
  link.updatedAt = new Date().toISOString();
  writeLinks(links);
  return link;
}

// ── watcher ────────────────────────────────────────────────────────────

let refreshWatchers: (() => void) | null = null;

/** Watch the folders holding synced files; re-check shortly after a change,
 * and on a slow poll for filesystems where watching is unreliable. */
export function startSyncWatcher(deps: SetupImportDeps, onChange: (report: SyncReport) => void): () => void {
  let watchers: FSWatcher[] = [];
  let timer: NodeJS.Timeout | null = null;
  const run = () => {
    timer = null;
    try {
      const report = checkSync(deps);
      if (report.applied.length || report.conflicts) onChange(report);
    } catch (error) {
      console.warn("[setup-import] sync check failed", error instanceof Error ? error.message : String(error));
    }
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, 1500);
    timer.unref?.();
  };
  const rebuild = () => {
    for (const watcher of watchers) watcher.close();
    watchers = [];
    const dirs = new Set<string>();
    for (const link of readLinks()) {
      if (!link.sync) continue;
      for (const file of linkFiles(link)) dirs.add(dirname(file));
    }
    for (const dir of dirs) {
      try {
        if (!lstatSync(dir).isDirectory() && !isDir(dir)) continue;
        const watcher = watch(dir, { persistent: false }, schedule);
        watcher.on("error", () => watcher.close());
        watchers.push(watcher);
      } catch {
        // a missing folder is picked up by the poll once it returns
      }
    }
  };
  refreshWatchers = rebuild;
  rebuild();
  run();
  const poll = setInterval(run, 10 * 60_000);
  poll.unref?.();
  return () => {
    refreshWatchers = null;
    clearInterval(poll);
    if (timer) clearTimeout(timer);
    for (const watcher of watchers) watcher.close();
  };
}
