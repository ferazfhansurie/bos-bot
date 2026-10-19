// Enterprise first-launch provisioning, server half.
//
// A per-client desktop build carries a provision file; on its first launch
// the desktop (electron/enterprise-provision.mjs) restores the client's hosted
// workspace through the ordinary workspace-backup routes, restarts this
// server, then hands the client's /setup document to the one route below.
// That route applies engines, MCP servers, feature flags and each bot's
// working folder and model — through the same config and store writes the
// settings screens use — after substituting the two install-specific
// placeholders. Credentials never travel this way: an engine that needs a
// sign-in asks for it in Settings → Engines, as on any other install.
//
// Both routes are local-only: the loopback owner (in the packaged app, the
// desktop holding the mutation token), never a paired session or the phone.
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isAbsolute, join, resolve, sep } from "node:path";
import { z } from "zod";

import type { RequestAuth } from "./request-auth.ts";

export const ENTERPRISE_RECEIPT_FILE = "enterprise-provision.json";
export const ENTERPRISE_STATE_FILE = "enterprise-provision-state.json";
export const ENTERPRISE_RUNTIME_DIR = "enterprise-runtime";
const PREFIX = "/api/enterprise-provision";
const MAX_SETUP_BYTES = 1024 * 1024;

const record = <T extends z.ZodType>(value: T) => z.record(z.string(), value);
const modelSelectionInput = z.object({
  instanceId: z.string().trim().min(1).max(200),
  model: z.string().trim().min(1).max(200),
  effort: z.string().optional(),
  variant: z.string().optional(),
}).strict();
/** The /setup document. Instances and MCP entries are validated again by the
 * config schema and the MCP registry when they are written. */
export const enterpriseSetupSchema = z.object({
  version: z.literal(1),
  features: record(z.boolean()).optional(),
  instances: record(z.object({
    driver: z.string().min(1).max(100),
    displayName: z.string().max(200).optional(),
    config: z.json().optional(),
    environment: record(z.string()).optional(),
    enabled: z.boolean().optional(),
  }).passthrough()).optional(),
  mcpServers: record(z.unknown()).optional(),
  bots: record(z.object({
    cwd: z.string().max(4096).optional(),
    modelSelection: modelSelectionInput.optional(),
  }).strict()).optional(),
}).strict();
export type EnterpriseSetup = z.output<typeof enterpriseSetupSchema>;

export interface Placeholders {
  /** The resolved data directory of this install. */
  dataDir: string;
  /** A node-compatible executable path (see writeNodeShim). */
  node: string;
}

/** Replace `{{DATA_DIR}}` and `{{NODE}}` in every string of a JSON value —
 * keys stay as written. An unknown `{{…}}` is left alone so it fails loudly
 * where it is used rather than being silently blanked. */
export function substitutePlaceholders<T>(value: T, placeholders: Placeholders): T {
  const swap = (text: string) => text
    .replaceAll("{{DATA_DIR}}", () => placeholders.dataDir)
    .replaceAll("{{NODE}}", () => placeholders.node);
  const walk = (input: unknown): unknown => {
    if (typeof input === "string") return swap(input);
    if (Array.isArray(input)) return input.map(walk);
    if (input && typeof input === "object") {
      return Object.fromEntries(Object.entries(input as Record<string, unknown>).map(([key, entry]) => [key, walk(entry)]));
    }
    return input;
  };
  return walk(value) as T;
}

/** A fresh workspace is one nobody has used: no bots, or only the seeded BOS
 * starter, no rooms, and no message a person wrote. Anything else is real data
 * that provisioning must never replace. */
export function isFreshWorkspace(input: {
  bots: ReadonlyArray<{ name: string }>;
  rooms: number;
  messages: number;
  userMessages: number;
}, starterName = "BOS"): boolean {
  if (input.rooms > 0 || input.userMessages > 0) return false;
  if (input.bots.length === 0) return input.messages === 0;
  return input.bots.length === 1 && input.bots[0]!.name === starterName && input.messages <= 1;
}

/** `{{NODE}}` on a desktop install. A Mac has no node of its own, and an MCP
 * entry cannot carry ELECTRON_RUN_AS_NODE (a reserved name), so the install
 * gets a tiny shell script that runs the app's own executable as node. It is
 * rewritten at every boot from the running executable, so moving or updating
 * the app keeps configured servers starting. */
export function nodeShimPath(dataDir: string): string {
  return join(dataDir, ENTERPRISE_RUNTIME_DIR, "node");
}

export function writeNodeShim(dataDir: string, execPath: string): string {
  if (process.platform === "win32") throw new Error("The enterprise node shim is POSIX-only.");
  const directory = join(dataDir, ENTERPRISE_RUNTIME_DIR);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (lstatSync(directory).isSymbolicLink()) throw new Error("The enterprise runtime folder must not be a symbolic link.");
  const target = nodeShimPath(dataDir);
  const quoted = `'${execPath.replaceAll("'", `'\\''`)}'`;
  const script = `#!/bin/sh\n# Written by BOS at startup: runs this app's own runtime as node.\nELECTRON_RUN_AS_NODE=1 exec ${quoted} "$@"\n`;
  try {
    if (readFileSync(target, "utf8") === script) { chmodSync(target, 0o755); return target; }
  } catch { /* first write */ }
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, script, { mode: 0o755 });
  chmodSync(temporary, 0o755);
  renameSync(temporary, target);
  return target;
}

/** Keep an existing shim pointed at the running executable. Installs that
 * never provisioned have no shim and get none. */
export function refreshNodeShim(dataDir: string, execPath: string): string | null {
  if (process.platform === "win32" || !existsSync(nodeShimPath(dataDir))) return null;
  return writeNodeShim(dataDir, execPath);
}

export interface EnterpriseApplyResult {
  instances: string[];
  mcpServers: string[];
  features: string[];
  bots: string[];
}

export interface EnterpriseProvisionDeps {
  dataDir: string;
  /** The executable the shim runs (process.execPath of this server). */
  execPath: string;
  readBody: (req: IncomingMessage, limit?: number) => Promise<unknown>;
  /** Loopback owner only: never a paired session or a companion device. */
  trustedLocal: (req: IncomingMessage, auth: RequestAuth) => boolean;
  workspace: () => { bots: Array<{ id: string; name: string }>; rooms: number; messages: number; userMessages: number };
  applyInstances: (instances: NonNullable<EnterpriseSetup["instances"]>) => Promise<void>;
  applyFeatures: (features: Record<string, boolean>) => void;
  /** Validated stored entries, merged over the existing registry. */
  applyMcpServers: (servers: Record<string, unknown>) => void;
  parseMcpServer: (name: string, raw: unknown) => { ok: true; server: unknown } | { ok: false; error: string };
  applyBot: (botId: string, patch: { cwd?: string; modelSelection?: z.output<typeof modelSelectionInput> }) => { ok: true } | { ok: false; error: string };
}

const failure = (message: string, status = 400) => Object.assign(new Error(message), { status });

/** Validate and apply one /setup document. Order matters: engines first so a
 * bot's model selection names an engine that exists, MCP entries before the
 * bots that may allow them. Every part is idempotent — a resumed provision
 * applies the same document again with the same outcome. */
export async function applyEnterpriseSetup(raw: unknown, deps: Pick<EnterpriseProvisionDeps,
  "dataDir" | "execPath" | "applyInstances" | "applyFeatures" | "applyMcpServers" | "parseMcpServer" | "applyBot" | "workspace">): Promise<EnterpriseApplyResult> {
  const parsed = enterpriseSetupSchema.safeParse(raw);
  if (!parsed.success) throw failure(`The setup document is invalid: ${parsed.error.issues[0]?.message ?? "unknown field"}`);
  const usesNode = JSON.stringify(parsed.data).includes("{{NODE}}");
  const node = usesNode ? writeNodeShim(deps.dataDir, deps.execPath) : nodeShimPath(deps.dataDir);
  const setup = substitutePlaceholders(parsed.data, { dataDir: deps.dataDir, node });
  const mcp: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(setup.mcpServers ?? {})) {
    const checked = deps.parseMcpServer(name, entry);
    if (!checked.ok) throw failure(`MCP server “${name}”: ${checked.error}`);
    mcp[name] = checked.server;
  }
  const known = new Set(deps.workspace().bots.map((bot) => bot.id));
  const missing = Object.keys(setup.bots ?? {}).filter((id) => !known.has(id));
  if (missing.length) throw failure(`The restored workspace has no bot ${missing[0]}.`, 409);

  if (setup.instances && Object.keys(setup.instances).length) await deps.applyInstances(setup.instances);
  if (setup.features && Object.keys(setup.features).length) deps.applyFeatures(setup.features);
  if (Object.keys(mcp).length) deps.applyMcpServers(mcp);
  for (const [botId, patch] of Object.entries(setup.bots ?? {})) {
    // A working folder inside this install's data folder may simply not have
    // been in the archive (an empty folder); anywhere else must already exist.
    if (patch.cwd !== undefined && isAbsolute(patch.cwd) && resolve(patch.cwd).startsWith(resolve(deps.dataDir) + sep)) {
      mkdirSync(resolve(patch.cwd), { recursive: true });
    }
    const applied = deps.applyBot(botId, patch);
    if (!applied.ok) throw failure(`Bot ${botId}: ${applied.error}`);
  }
  return {
    instances: Object.keys(setup.instances ?? {}),
    mcpServers: Object.keys(mcp),
    features: Object.keys(setup.features ?? {}),
    bots: Object.keys(setup.bots ?? {}),
  };
}

export function createEnterpriseProvisionRoutes(deps: EnterpriseProvisionDeps) {
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  let applying = false;
  return async (req: IncomingMessage, res: ServerResponse, path: string, auth: RequestAuth): Promise<boolean> => {
    if (path !== `${PREFIX}/status` && path !== `${PREFIX}/apply`) return false;
    if (!deps.trustedLocal(req, auth)) { json(res, 403, { error: "Enterprise setup is only available to this computer's desktop app." }); return true; }
    try {
      if (req.method === "GET" && path === `${PREFIX}/status`) {
        const workspace = deps.workspace();
        json(res, 200, { fresh: isFreshWorkspace(workspace), bots: workspace.bots.length, rooms: workspace.rooms, messages: workspace.messages });
        return true;
      }
      if (req.method === "POST" && path === `${PREFIX}/apply`) {
        if (applying) throw failure("Enterprise setup is already being applied.", 409);
        applying = true;
        try {
          const body = await deps.readBody(req, MAX_SETUP_BYTES) as { setup?: unknown } | null;
          json(res, 200, { applied: await applyEnterpriseSetup(body?.setup, deps) });
        } finally { applying = false; }
        return true;
      }
      json(res, 405, { error: "Method not allowed" });
    } catch (error) {
      if (res.headersSent) { res.destroy(); return true; }
      const status = (error as { status?: number }).status;
      json(res, typeof status === "number" ? status : 400, { error: error instanceof Error ? error.message : "Enterprise setup failed." });
    }
    return true;
  };
}
