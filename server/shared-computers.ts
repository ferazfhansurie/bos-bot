import { randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const folder = z.object({ id: z.string().uuid(), name: z.string().min(1).max(120), write: z.boolean() }).strict();
export const sharedComputerRegistration = z.object({
  id: z.string().uuid(), name: z.string().min(1).max(120), environmentId: z.string().uuid(),
  folders: z.array(folder).max(20), terminal: z.boolean(), computer: z.boolean(),
  // The desktop's own BOS browser window serves this workspace's browser tools.
  browser: z.boolean().optional(),
  allowedBotIds: z.array(z.string().uuid()).min(1).max(100).optional(),
}).strict();
export const sharedComputerOperation = z.object({
  computer_id: z.string().uuid(),
  action: z.enum(["list_files", "read_file", "write_file", "run_command", "computer_tools", "computer_call", "browser_rpc", "browser_release"]),
  folder_id: z.string().uuid().optional(), path: z.string().max(2048).optional(),
  content: z.string().max(350_000).optional(), encoding: z.enum(["utf8", "base64"]).optional(),
  expected_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  command: z.string().max(8000).optional(), tool_name: z.string().max(100).optional(),
  arguments: z.record(z.string(), z.unknown()).optional(),
  // browser_rpc / browser_release: one agent_browser MCP call for one turn.
  method: z.enum(["tools/list", "tools/call"]).optional(), params: z.record(z.string(), z.unknown()).optional(),
  bot_id: z.string().max(200).optional(), thread_id: z.string().max(200).optional(), generation: z.string().max(200).optional(),
  profile_id: z.string().max(200).optional(), full_access: z.boolean().optional(), timeout_ms: z.number().int().min(1000).max(40_000).optional(),
}).strict();
type Registration = z.infer<typeof sharedComputerRegistration>;
type Operation = z.infer<typeof sharedComputerOperation>;
type Job = { id: string; operation: Operation; active: () => boolean; sent: boolean; resolve: (result: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
type Computer = { registration: Registration; owner: string; secret: string; seen: number; jobs: Map<string, Job>; wake?: () => void };
const failure = (message: string, status = 409) => Object.assign(new Error(message), { status });

/** In-memory rendezvous only. Authority over local resources stays on the
 * desktop. Restart/disconnect NEVER replays an operation with an unknown outcome. */
export class SharedComputers {
  private computers = new Map<string, Computer>();
  private sessionLive: (id: string) => boolean;
  constructor(sessionLive: (id: string) => boolean) { this.sessionLive = sessionLive; }
  register(registration: Registration, owner: string, secret: string) {
    if (!/^[a-f0-9]{64}$/.test(secret)) throw failure("Invalid computer credential", 400);
    const old = this.computers.get(registration.id);
    if (old) {
      this.authorize(registration.id, owner, secret);
      old.registration = registration; old.seen = Date.now();
    } else {
      // Reap dead devices before applying the bounded registration limit.
      for (const [id, entry] of this.computers) if (!this.online(entry) && entry.jobs.size === 0) this.computers.delete(id);
      if (this.computers.size >= 20) throw failure("Too many shared computers");
      this.computers.set(registration.id, { registration, owner, secret, seen: Date.now(), jobs: new Map() });
    }
  }
  private online(entry: Computer) { return this.sessionLive(entry.owner) && Date.now() - entry.seen < 40_000; }
  private authorize(id: string, owner: string, secret: string) {
    const entry = this.computers.get(id);
    if (!entry || entry.owner !== owner || !this.sessionLive(owner) || !/^[a-f0-9]{64}$/.test(secret) || !timingSafeEqual(Buffer.from(secret), Buffer.from(entry.secret))) throw failure("Shared computer is disconnected or not authorized", 403);
    return entry;
  }
  private allowed(entry: Computer, botId?: string) {
    return !entry.registration.allowedBotIds || (botId !== undefined && entry.registration.allowedBotIds.includes(botId));
  }
  list(botId?: string) { return [...this.computers.values()].filter(entry => this.online(entry) && (botId === undefined || this.allowed(entry, botId))).map(entry => entry.registration); }
  async poll(id: string, owner: string, secret: string) {
    const entry = this.authorize(id, owner, secret);
    if (entry.wake) throw failure("A computer poll is already running");
    entry.seen = Date.now();
    const next = () => {
      for (const job of entry.jobs.values()) {
        if (!job.active()) { this.finish(entry, job, failure("The requesting turn ended")); continue; }
        if (!job.sent) { job.sent = true; return { id: job.id, operation: job.operation }; }
      }
      return null;
    };
    const queued = next();
    if (queued) return queued;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { entry.wake = undefined; resolve(); }, 20_000);
      entry.wake = () => { clearTimeout(timer); entry.wake = undefined; resolve(); };
    });
    this.authorize(id, owner, secret);
    entry.seen = Date.now();
    return next();
  }
  liveJob(id: string, owner: string, secret: string, jobId: string) {
    const entry = this.authorize(id, owner, secret);
    entry.seen = Date.now();
    const job = entry.jobs.get(jobId);
    return job?.sent === true && job.active();
  }
  complete(id: string, owner: string, secret: string, jobId: string, result: unknown) {
    const entry = this.authorize(id, owner, secret);
    const job = entry.jobs.get(jobId);
    if (!job || !job.sent) throw failure("This computer operation expired; it will not be replayed");
    this.finish(entry, job, job.active() ? null : failure("The requesting turn ended"), result);
  }
  disconnect(id: string, owner: string, secret: string) {
    const entry = this.authorize(id, owner, secret);
    this.computers.delete(id); entry.wake?.();
    for (const job of entry.jobs.values()) this.finish(entry, job, failure("Computer disconnected. An in-flight action may have completed; inspect before retrying."));
  }
  /** Online computers whose desktop browser serves this bot's browser tools. */
  browsers(botId: string) { return this.list(botId).filter(entry => entry.browser === true); }
  request(operation: Operation, active: () => boolean, botId?: string): Promise<unknown> {
    const entry = this.computers.get(operation.computer_id);
    if (!entry || !this.online(entry)) return Promise.reject(failure("This shared computer is offline. Keep its desktop app open; do not substitute files on the server."));
    if (!this.allowed(entry, botId)) return Promise.reject(failure("This bot has no grant for this shared computer", 403));
    const browser = operation.action === "browser_rpc" || operation.action === "browser_release";
    if (browser && entry.registration.browser !== true) return Promise.reject(failure("This computer does not share its browser", 403));
    // Browser calls are serialized per conversation on the desktop, so several
    // turns may browse at once; files, terminal and screen stay one at a time.
    const queued = [...entry.jobs.values()].filter(job => (job.operation.action === "browser_rpc" || job.operation.action === "browser_release") === browser).length;
    if (queued >= (browser ? 8 : 1)) return Promise.reject(failure("This shared computer is busy. Wait for its current action to finish."));
    if (!active()) return Promise.reject(failure("The requesting turn ended", 401));
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timeout = browser ? (operation.timeout_ms ?? 20_000) + 10_000 : 45_000;
      const job: Job = { id, operation, active: () => active() && this.allowed(entry, botId), sent: false, resolve, reject, timer: setTimeout(() => this.finish(entry, job, failure("Computer action timed out. Its outcome is unknown; inspect before retrying.")), timeout) };
      entry.jobs.set(id, job); entry.wake?.();
    });
  }
  close() {
    for (const entry of this.computers.values()) {
      entry.wake?.();
      for (const job of entry.jobs.values()) this.finish(entry, job, failure("Workspace stopped. Inspect any in-flight action before retrying."));
    }
    this.computers.clear();
  }
  private finish(entry: Computer, job: Job, error: Error | null, result?: unknown) {
    clearTimeout(job.timer); entry.jobs.delete(job.id);
    if (error) job.reject(error); else job.resolve(result);
  }
}
