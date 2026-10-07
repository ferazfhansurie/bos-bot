import { createHash } from "node:crypto";
import type { Invocation } from "../shared/cloud-run-draft.ts";
import type { RuntimeEvent } from "../shared/runtime-events.ts";
import { CloudRoomHost, type CloudRoomHostDeps, type HostSocketCtor, type TurnResult } from "./cloud-host.ts";

/** Binds CloudRoomHost to the native turn path in server/index.ts. Each
 * cloud (workspace, room, thread, bot) gets one private execution task,
 * registered as a shared-bot task so startTurn runs it with conversation-only
 * isolation (no soul, memory, connected apps or computer) like a local room
 * turn. The provider receives the exact source text; who sent it rides on the
 * stored message's structured `sender`, the invocation on its `sendId`. */
export interface CloudHostRuntimeDeps {
  store: {
    bot(botId: string): { id: string; name: string; hidden?: boolean } | null | undefined;
    taskByThread(botId: string, threadId: string): unknown;
    createTask(botId: string, title: string, activate: boolean): { threadId: string } | null;
    patchTask(botId: string, threadId: string, patch: { approvalMode: "ask"; autoApprove: false; alwaysAllow: []; cwd: string }): unknown;
    projectBotForTask(botId: string, threadId: string): { modelSelection?: { model?: string } } | null | undefined;
    messagesFor(threadId: string): Array<{ role: string; sendId?: string }>;
  };
  sharedBotTasks: { get(roomKey: string, botId: string): string | undefined; set(roomKey: string, botId: string, threadId: string): void };
  bus: { subscribe(listener: (event: RuntimeEvent) => void): () => void };
  /** index.ts startTurn; resolves once the user line is recorded, dispatch continues in the background. */
  startTurn(botId: string, text: string, opts: {
    threadId: string; sendId: string; sender: { name: string }; userMessage?: unknown;
    requestGuard: () => void; onDispatchError: (message: string) => void;
  }): Promise<unknown>;
  interruptDirectThread(botId: string, threadId: string): Promise<void>;
  /** Thread busy, bot at capacity, parked behind coordination or in a group turn. */
  admissionBlocked(botId: string, threadId: string): boolean;
  shouldIgnoreProviderEvent(event: RuntimeEvent): boolean;
  /** Private working folder for the execution task; created by the caller. */
  sandboxFor(threadId: string): string;
  log?: (message: string) => void;
  admissionPollMs?: number;
  /** After a stop/abort, give the native turn this long to report completion. */
  abortGraceMs?: number;
  /** Hard ceiling for one turn (an unanswerable approval would otherwise hold the lease). */
  maxTurnMs?: number;
}

export function cloudRoomKey(invocation: { workspace_id: string; room_id: string; thread_id: string }): string {
  return `cloud-${createHash("sha256").update(`${invocation.workspace_id}/${invocation.room_id}/${invocation.thread_id}`).digest("hex").slice(0, 32)}`;
}

export function createCloudHostRuntime(deps: CloudHostRuntimeDeps): Pick<CloudRoomHostDeps, "runTurn" | "stopTurn" | "canHost"> {
  const running = new Map<string, { botId: string; threadId: string }>();
  const log = deps.log ?? (() => {});
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  function executionThread(invocation: Invocation, bot: { id: string; name: string }): string {
    const roomKey = cloudRoomKey(invocation);
    let threadId = deps.sharedBotTasks.get(roomKey, bot.id);
    if (!threadId || !deps.store.taskByThread(bot.id, threadId)) {
      const task = deps.store.createTask(bot.id, "cloud room", false);
      if (!task) throw new Error("could not create the cloud room task");
      threadId = task.threadId;
      deps.sharedBotTasks.set(roomKey, bot.id, threadId);
    }
    deps.store.patchTask(bot.id, threadId, { approvalMode: "ask", autoApprove: false, alwaysAllow: [], cwd: deps.sandboxFor(threadId) });
    return threadId;
  }

  async function runTurn(invocation: Invocation, io: { onDelta(text: string): void; signal: AbortSignal }): Promise<TurnResult> {
    const bot = deps.store.bot(invocation.bot_id);
    if (!bot || bot.hidden) return { ok: false, failure: "bot is not available on this host", model: null };
    let threadId: string;
    try { threadId = executionThread(invocation, bot); }
    catch (error) { return { ok: false, failure: error instanceof Error ? error.message : "could not prepare the bot", model: null }; }
    while (deps.admissionBlocked(bot.id, threadId)) {
      if (io.signal.aborted) return { ok: false, failure: "stopped before the turn started", model: null };
      await sleep(deps.admissionPollMs ?? 250);
    }
    if (io.signal.aborted) return { ok: false, failure: "stopped before the turn started", model: null };
    // The configured selection for this task; replaced by what the provider
    // session announces (session.started.model) or a quota switch.
    let model: string | null = deps.store.projectBotForTask(bot.id, threadId)?.modelSelection?.model ?? null;
    running.set(invocation.invocation_id, { botId: bot.id, threadId });
    try {
      return await new Promise<TurnResult>(resolve => {
        let text = "";
        let newItem = false;
        let done = false;
        let abortTimer: ReturnType<typeof setTimeout> | undefined;
        const finish = (result: TurnResult) => {
          if (done) return;
          done = true;
          clearTimeout(abortTimer);
          clearTimeout(ceiling);
          io.signal.removeEventListener("abort", onAbort);
          unsubscribe();
          resolve(result);
        };
        const unsubscribe = deps.bus.subscribe(event => {
          if (event.threadId !== threadId || deps.shouldIgnoreProviderEvent(event)) return;
          if (event.type === "session.started" && typeof event.model === "string" && event.model) model = event.model;
          else if (event.type === "model.switched" && event.botId === bot.id && event.to) model = event.to;
          else if (event.type === "content.delta" && event.streamKind === "assistant_text" && event.delta) {
            io.onDelta(newItem ? `\n${event.delta}` : event.delta);
            newItem = false;
          } else if (event.type === "item.completed" && event.itemType === "assistant_text") {
            text += (text ? "\n" : "") + event.text;
            newItem = true;
          } else if (event.type === "turn.completed") {
            if (event.ok && text) finish({ ok: true, text, model });
            else finish({ ok: false, failure: event.ok ? "the bot finished without a text reply" : event.stopReason || "the bot could not finish its turn", model });
          }
        });
        // The host interrupts the native turn on stop/fence/lease loss; a turn
        // that never reports completion is still settled after a grace period.
        const onAbort = () => { abortTimer = setTimeout(() => finish({ ok: false, failure: "stopped", model }), deps.abortGraceMs ?? 30_000); };
        io.signal.addEventListener("abort", onAbort, { once: true });
        const ceiling = setTimeout(() => {
          log(`cloud host: ${invocation.invocation_id} hit the turn ceiling; interrupting`);
          void deps.interruptDirectThread(bot.id, threadId).catch(() => {});
          finish({ ok: false, failure: "the turn took too long", model });
        }, deps.maxTurnMs ?? 30 * 60_000);
        const sendId = `cloud-${invocation.invocation_id}`;
        // A reclaimed attempt reuses the line the first attempt recorded.
        const recovered = deps.store.messagesFor(threadId).findLast(message => message.role === "user" && message.sendId === sendId);
        const base = {
          threadId, sendId,
          sender: { name: invocation.source.actor_name?.trim() || "Room member" },
          requestGuard: () => { if (io.signal.aborted) throw Object.assign(new Error("cloud invocation stopped"), { status: 409 }); },
          onDispatchError: (message: string) => finish({ ok: false, failure: message, model }),
        };
        deps.startTurn(bot.id, invocation.source.text, recovered ? { ...base, userMessage: recovered } : base)
          .catch(error => finish({ ok: false, failure: error instanceof Error ? error.message : String(error), model }));
      });
    } finally {
      running.delete(invocation.invocation_id);
    }
  }

  return {
    runTurn,
    stopTurn: async invocationId => {
      const turn = running.get(invocationId);
      if (turn) await deps.interruptDirectThread(turn.botId, turn.threadId);
    },
    canHost: botId => {
      const bot = deps.store.bot(botId);
      return Boolean(bot && !bot.hidden);
    },
  };
}

/** Starts the host only when both OMB_CLOUD_HOST_URL and OMB_CLOUD_HOST_TOKEN
 * are set, and never in the packaged desktop app (dev build only for slice 3). */
export function startCloudHostFromEnv(env: NodeJS.ProcessEnv, deps: CloudHostRuntimeDeps): CloudRoomHost | null {
  const url = env.OMB_CLOUD_HOST_URL?.trim();
  const hostToken = env.OMB_CLOUD_HOST_TOKEN?.trim();
  if (!url || !hostToken) return null;
  const log = deps.log ?? ((message: string) => console.warn(message));
  if (env.OMB_RESOURCES_PATH) { log("cloud host: ignored in the packaged app (dev build only)"); return null; }
  const Socket = (globalThis as { WebSocket?: HostSocketCtor }).WebSocket;
  if (!Socket) { log("cloud host: this runtime has no WebSocket"); return null; }
  try {
    const host = new CloudRoomHost({ url, hostToken, Socket, log, ...createCloudHostRuntime({ ...deps, log }) });
    host.start();
    log("cloud host: connecting to the room service");
    return host;
  } catch (error) {
    log(`cloud host: not started: ${error instanceof Error ? error.message : "unknown"}`);
    return null;
  }
}
