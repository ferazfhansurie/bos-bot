import { copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { MOD_REQUEST_TIMEOUT_MS, bridgeRequest, modBundle, modId, type ModRecord, type ModBundle, type BridgeRequest } from "../shared/mods.ts";
const stateSchema = z.object({ botId: z.string().min(1).max(100), enabled: z.boolean(), revision: z.string().uuid() }).strict();
const fail = (message: string, status = 400): never => { throw Object.assign(new Error(message), { status }); };
function regular(path: string, directory = false) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile()) || (!directory && stat.size > 600_000)) fail("Mod files must be regular files");
}
export class ModStore {
  readonly root: string;
  private safe: () => boolean;
  constructor(dataDir: string, safe: () => boolean = () => false) {
    this.safe = safe;
    this.root = join(dataDir, "mods"); mkdirSync(this.root, { recursive: true }); regular(this.root, true);
  }
  private dir(id: string) { modId.parse(id); regular(this.root, true); const dir = join(this.root, id); regular(dir, true); return dir; }
  private read(dir: string, name: string) { const path = join(dir, name); regular(path); return readFileSync(path, "utf8"); }
  get(id: string): ModRecord {
    const dir = this.dir(id);
    const manifest = JSON.parse(this.read(dir, "manifest.json"));
    // Dot files are ours (state, storage, and temp files a crash left behind), never mod files.
    const files = Object.fromEntries(readdirSync(dir).filter(name => name !== "manifest.json" && !name.startsWith(".")).map(name => [name, this.read(dir, name)]));
    const bundle = modBundle.parse({ manifest, files }); if (bundle.manifest.id !== id) fail("Mod id mismatch");
    const state = stateSchema.parse(JSON.parse(this.read(dir, ".bos.json")));
    return { ...bundle, botId: state.botId, revision: state.revision, requestedEnabled: state.enabled, enabled: state.enabled && !this.safe() };
  }
  list() { return readdirSync(this.root).filter(name => modId.safeParse(name).success).flatMap(id => { try { return [this.get(id)]; } catch { return []; } }); }
  save(input: unknown, botId: string) {
    const bundle = modBundle.parse(input); const id = bundle.manifest.id; const dest = join(this.root, id);
    regular(this.root, true);
    if (existsSync(dest) && this.get(id).botId !== botId) fail("This mod belongs to another bot", 403);
    const stage = join(this.root, `.stage-${randomUUID()}`); mkdirSync(stage);
    const backup = join(this.root, `.backup-${randomUUID()}`);
    try {
      for (const [name, contents] of Object.entries(bundle.files)) writeFileSync(join(stage, name), contents, { mode: 0o600, flag: "wx" });
      writeFileSync(join(stage, "manifest.json"), JSON.stringify(bundle.manifest), { mode: 0o600 });
      writeFileSync(join(stage, ".bos.json"), JSON.stringify({ botId, enabled: false, revision: randomUUID() }), { mode: 0o600 });
      // A mod's saved data outlives an edit of its code.
      const storage = join(dest, ".storage.json");
      if (existsSync(storage)) { regular(storage); copyFileSync(storage, join(stage, ".storage.json")); }
      if (existsSync(dest)) { renameSync(dest, backup); }
      try { renameSync(stage, dest); } catch (error) { if (existsSync(backup)) renameSync(backup, dest); throw error; }
      rmSync(backup, { recursive: true, force: true });
    } finally { rmSync(stage, { recursive: true, force: true }); }
    return this.get(id);
  }
  enable(id: string, enabled: boolean) {
    const mod = this.get(id); if (enabled && this.safe()) fail("Mods are off in safe mode", 409);
    const dir = this.dir(id); const path = join(dir, ".bos.json"); regular(path);
    const stage = join(dir, `.state-${randomUUID()}`);
    writeFileSync(stage, JSON.stringify({ botId: mod.botId, enabled, revision: randomUUID() }), { mode: 0o600 }); renameSync(stage, path);
    return this.get(id);
  }
  delete(id: string) { const dir = this.dir(id); rmSync(dir, { recursive: true }); }
  active(id: string, botId: string) { const mod = this.get(id); if (!mod.enabled || mod.botId !== botId) fail("Mod is off or unavailable for this bot", 403); return mod; }
  export(id: string): ModBundle { const { manifest, files } = this.get(id); return { manifest, files }; }
  storage(id: string, key: string, value?: unknown, write = false) {
    const dir = this.dir(id), path = join(dir, ".storage.json");
    const values: Record<string, unknown> = existsSync(path) ? JSON.parse(this.read(dir, ".storage.json")) : {};
    if (!write) return Object.hasOwn(values, key) ? values[key] : null;
    values[key] = value; const body = JSON.stringify(values); if (body.length > 64_000) fail("Mod storage is full");
    const stage = join(dir, `.storage-${randomUUID()}`); writeFileSync(stage, body, { mode: 0o600 }); renameSync(stage, path); return null;
  }
}
export interface ModBridgeDeps {
  threads: (botId: string) => unknown;
  ask: (botId: string, prompt: string, signal: AbortSignal) => Promise<unknown>;
  app: (botId: string, prompt: string, signal: AbortSignal) => Promise<unknown>;
}
export class ModBridge {
  private calls = new Map<string, { count: number; since: number; pending: number }>();
  private store: ModStore;
  private deps: ModBridgeDeps;
  private limits: { maxCalls?: number; timeoutMs?: number };
  constructor(store: ModStore, deps: ModBridgeDeps, limits: { maxCalls?: number; timeoutMs?: number } = {}) { this.store = store; this.deps = deps; this.limits = limits; }
  async call(id: string, botId: string, input: unknown, guard: () => void = () => {}, expectedRevision?: string) {
    const request: BridgeRequest = bridgeRequest.parse(input);
    if (JSON.stringify(input).length > 16_000) fail("Mod request is too large");
    guard();
    const mod = this.store.active(id, botId);
    if (expectedRevision && expectedRevision !== mod.revision) fail("Mod changed; reload before requesting access", 409);
    const permission = request.method.startsWith("storage:") ? "storage" : request.method;
    if (!(mod.manifest.permissions as string[]).includes(permission)) fail("Mod permission was not declared", 403);
    const now = Date.now();
    for (const [key, value] of this.calls) if (!value.pending && now - value.since > 60_000) this.calls.delete(key);
    const key = `${id}:${botId}`; let rate = this.calls.get(key);
    if (!rate) { rate = { count: 0, since: now, pending: 0 }; this.calls.set(key, rate); }
    if (rate.count >= (this.limits.maxCalls ?? 30) || rate.pending >= 3) fail("Too many mod requests; try again shortly", 429);
    rate.count++; rate.pending++;
    const controller = new AbortController();
    const revoked = () => { try { guard(); return this.store.active(id, botId).revision !== mod.revision; } catch { return true; } };
    let watch: ReturnType<typeof setInterval> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const work = async () => {
        switch (request.method) {
          case "threads:read": return this.deps.threads(botId);
          case "bots:ask": return this.deps.ask(botId, request.params.prompt, controller.signal);
          case "apps:call": return this.deps.app(botId, request.params.prompt, controller.signal);
          case "storage:get": return this.store.storage(id, request.params.key);
          case "storage:set": return this.store.storage(id, request.params.key, request.params.value, true);
        }
      };
      const result = await Promise.race([work(), new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("Mod request timed out")); }, this.limits.timeoutMs ?? MOD_REQUEST_TIMEOUT_MS);
        watch = setInterval(() => { if (revoked()) { controller.abort(); reject(new Error("Mod access ended")); } }, 100); })]);
      guard();
      if (this.store.active(id, botId).revision !== mod.revision) fail("Mod changed while working", 409);
      return result;
    } finally { if (timer) clearTimeout(timer); if (watch) clearInterval(watch); rate.pending--; }
  }
}
