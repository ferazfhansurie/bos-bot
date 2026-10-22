import { z } from "zod";
const unique = <T,>(values: T[]) => new Set(values).size === values.length;
// "import" is the route /api/mods/import, so it can never be a mod id.
export const modId = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/).refine(id => id !== "import", "This mod id is reserved");
export const modManifest = z.object({
  id: modId, name: z.string().trim().min(1).max(80),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/).max(64),
  description: z.string().trim().min(1).max(500),
  surfaces: z.array(z.enum(["panel", "band", "chip", "command"])).min(1).max(4).refine(unique),
  permissions: z.array(z.enum(["threads:read", "bots:ask", "apps:call", "storage"])).max(4).refine(unique),
}).strict();
export const modBundle = z.object({ manifest: modManifest,
  files: z.record(z.string().regex(/^(?:index\.html|[a-zA-Z0-9_-]+\.(?:js|css))$/), z.string().max(256_000))
    .refine(files => typeof files["index.html"] === "string" && Object.keys(files).length <= 20 && JSON.stringify(files).length <= 512_000),
}).strict();
const key = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
const common = { id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/) };
export const bridgeRequest = z.discriminatedUnion("method", [
  z.object({ ...common, method: z.literal("threads:read"), params: z.object({}).strict() }).strict(),
  z.object({ ...common, method: z.literal("bots:ask"), params: z.object({ prompt: z.string().trim().min(1).max(8000) }).strict() }).strict(),
  z.object({ ...common, method: z.literal("apps:call"), params: z.object({ prompt: z.string().trim().min(1).max(8000) }).strict() }).strict(),
  z.object({ ...common, method: z.literal("storage:get"), params: z.object({ key }).strict() }).strict(),
  z.object({ ...common, method: z.literal("storage:set"), params: z.object({ key, value: z.json() }).strict() }).strict(),
]);
export type ModManifest = z.infer<typeof modManifest>;
export type ModBundle = z.infer<typeof modBundle>;
export type BridgeRequest = z.infer<typeof bridgeRequest>;
export interface ModRecord extends ModBundle { botId: string; enabled: boolean; requestedEnabled: boolean; revision: string }
export const MOD_REQUEST_TIMEOUT_MS = 120_000;
export const MOD_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; img-src data:; font-src 'none'; media-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

/** A turn a mod starts (bots:ask, apps:call) runs on untrusted mod content,
 * and a shared .bosmod can be written by anyone. Its agent tools are read-only:
 * no teammates, threads, memory, skills, mods or proposals, so a mod can't
 * hand work to a fuller-access teammate or plant instructions. */
export const MOD_REQUEST_AGENT_TOOLS: ReadonlySet<string> = new Set([
  "tool_result_read", "list_bots", "list_rooms", "list_threads", "list_routines",
  "session_search", "session_read", "skills_list", "get_work_plan",
]);
/** Server side of the same rule: reads, plus spilling the turn's own oversized
 * tool output. Every other internal route writes or starts work. */
export function modRequestMayUse(method: string, path: string): boolean {
  return method === "GET" || method === "HEAD" || (method === "POST" && path === "/api/internal/tool-result");
}
