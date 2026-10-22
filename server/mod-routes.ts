import { z } from "zod";
import { modBundle, modId } from "../shared/mods.ts";
import type { ModBridge, ModStore } from "./mods.ts";
export interface ModHttp {
  store: ModStore; bridge: ModBridge;
  assertAccess: () => void;
  readBody: (limit: number) => Promise<any>;
  json: (status: number, value: unknown) => void;
  download: (name: string, body: string) => void;
  botExists: (id: string) => boolean;
  botId?: string;
}
export async function handleModRoute(method: string, path: string, deps: ModHttp): Promise<boolean> {
  const m = /^\/api\/(internal\/)?mods(?:\/([a-z][a-z0-9-]{0,63})(?:\/(enabled|export|bridge))?)?$/.exec(path);
  if (!m) return false;
  try {
    deps.assertAccess(); const [, internal, id, action] = m;
    const read = async (limit = 600_000) => { const body = await deps.readBody(limit); deps.assertAccess(); return body; };
    if (!id && method === "GET") {
      const mods = deps.store.list().filter(mod => !internal || mod.botId === deps.botId).map(({ files: _files, ...mod }) => mod);
      deps.json(200, { mods }); return true;
    }
    if (id === "import" && !action && method === "POST" && !internal) {
      const input = z.object({ bundle: z.unknown(), botId: z.string().min(1).max(100) }).strict().parse(await read());
      if (!deps.botExists(input.botId)) throw new Error("Choose an available bot for this mod");
      deps.json(201, { mod: deps.store.save(input.bundle, input.botId) }); return true;
    }
    if (!id || !modId.safeParse(id).success) throw new Error("Choose a mod id");
    if (internal && (action || (method !== "PUT" && deps.store.get(id).botId !== deps.botId))) {
      deps.json(403, { error: "Bots can only manage their own mod files; enabling needs the owner" }); return true;
    }
    if (method === "PUT" && !action) {
      const input = z.object({ bundle: z.unknown(), botId: z.string().min(1).max(100).optional() }).strict().parse(await read());
      const botId = internal ? deps.botId! : input.botId;
      if (!botId || !deps.botExists(botId) || (internal && input.botId && input.botId !== botId)) throw new Error("Choose an available bot for this mod");
      const bundle = modBundle.parse(input.bundle);
      if (bundle.manifest.id !== id) throw new Error("Mod id must match the URL");
      const mod = deps.store.save(bundle, botId);
      deps.json(200, { mod }); return true;
    }
    if (method === "GET" && !action) deps.json(200, { mod: deps.store.get(id) });
    else if (method === "DELETE" && !action) { deps.store.delete(id); deps.json(200, { ok: true }); }
    else if (method === "POST" && action === "enabled" && !internal) {
      const { enabled, revision } = z.object({ enabled: z.boolean(), revision: z.string().uuid().optional() }).strict().parse(await read(1000));
      if (enabled && revision !== deps.store.get(id).revision) { deps.json(409, { error: "This mod changed. Review its permissions again before enabling." }); return true; }
      deps.json(200, { mod: deps.store.enable(id, enabled) });
    } else if (method === "GET" && action === "export" && !internal) deps.download(`${id}.bosmod`, JSON.stringify(deps.store.export(id)));
    else if (method === "POST" && action === "bridge" && !internal) {
      const input = z.object({ botId: z.string().min(1).max(100), revision: z.string().uuid(), request: z.unknown() }).strict().parse(await read(20_000));
      if (!deps.botExists(input.botId)) throw new Error("Bot unavailable");
      deps.json(200, { result: await deps.bridge.call(id, input.botId, input.request, deps.assertAccess, input.revision) });
    } else deps.json(405, { error: "Method not allowed" });
  } catch (error) {
    const e = error as Error & { status?: number; code?: string };
    deps.json(e.status ?? (e.code === "ENOENT" ? 404 : 400), { error: e instanceof z.ZodError ? "Invalid mod manifest, files, or request" : e.message });
  }
  return true;
}
