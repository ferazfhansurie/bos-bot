// The win32 executor: the Electron main process owns the installer there
// (sha512-verified NSIS via electron-updater) and the relaunch, so the server
// asks it over the private utility-process port. Three request/result pairs,
// the same shape managed-desktop uses; main's electron/windows-update-contract.mjs
// answers them. Checkpoint, stop, quiesce, plan.json, result.json and resume
// are the coordinator's and identical to darwin: main writes plan.resultPath
// only from the NEXT host generation, after the new server is healthy.
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import type { ExecutorCandidate, ExecutorPlan, UpdateExecutor, UpdateMode } from "./updater.ts";

export interface UpdatePort {
  on(event: "message", listener: (event: { data?: object }) => void): void;
  postMessage(message: object): void;
}
export interface ElectronExecutorOptions {
  /** process.parentPort inside Electron's utility process; absent in plain Node. */
  port: UpdatePort | undefined;
  serverPort: number;
  /** Ports main must see listening again after relaunch, counted only when bound now (the companion gateway). */
  extraPorts?: number[];
  timeoutMs?: { candidate?: number; admit?: number; execute?: number };
  checkPort?: (port: number) => Promise<boolean>;
  log?: (line: string) => void;
}

const PREFIX = "openmausbot:update-";
const err = (message: string, status: number, extra: Record<string, unknown> = {}) => Object.assign(new Error(message), { status, ...extra });

function listening(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (value: boolean) => { socket.destroy(); resolve(value); };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}

function validCandidate(value: unknown): ExecutorCandidate | null {
  if (!value || typeof value !== "object") return null;
  const { version, sha, stagedAt } = value as Record<string, unknown>;
  // sha is whatever main verified the installer with (sha512 hex on Windows); only shown, never sliced for meaning.
  if (typeof version !== "string" || !version || typeof sha !== "string" || !sha || typeof stagedAt !== "string" || !stagedAt) return null;
  return { version, sha, stagedAt };
}

export function createElectronUpdateExecutor(options: ElectronExecutorOptions): UpdateExecutor {
  const log = options.log ?? (() => {});
  const waiting = new Map<string, { type: string; resolve: (reply: Record<string, unknown>) => void }>();
  options.port?.on("message", event => {
    const message = event?.data as { type?: unknown; requestId?: unknown } | undefined;
    if (typeof message?.type !== "string" || !message.type.startsWith(PREFIX) || !message.type.endsWith("-result")) return;
    if (typeof message.requestId !== "string") return;
    const pending = waiting.get(message.requestId);
    if (!pending || `${pending.type}-result` !== message.type) return;
    waiting.delete(message.requestId);
    pending.resolve(message as Record<string, unknown>);
  });
  const request = (kind: "candidate" | "admit" | "execute", body: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown> | null> => {
    const port = options.port;
    if (!port) return Promise.resolve(null);
    const type = `${PREFIX}${kind}`;
    const requestId = randomUUID();
    return new Promise(resolve => {
      const timer = setTimeout(() => { if (waiting.delete(requestId)) { log(`[update] desktop did not answer ${kind} within ${timeoutMs}ms`); resolve(null); } }, timeoutMs);
      timer.unref?.();
      waiting.set(requestId, { type, resolve: reply => { clearTimeout(timer); resolve(reply); } });
      try { port.postMessage({ type, requestId, ...body }); }
      catch (error) { clearTimeout(timer); waiting.delete(requestId); log(`[update] could not reach the desktop: ${error instanceof Error ? error.message : String(error)}`); resolve(null); }
    });
  };
  const refusal = (reply: Record<string, unknown>, fallback: string) =>
    err(typeof reply.error === "string" && reply.error ? reply.error : fallback, typeof reply.status === "number" ? reply.status : 409, reply.pending === true ? { pending: true } : {});
  const timeouts = { candidate: 5_000, admit: 10_000, execute: 60_000, ...options.timeoutMs };
  return {
    async candidate() {
      if (!options.port) return null;
      const reply = await request("candidate", {}, timeouts.candidate);
      if (!reply) throw err("the desktop did not answer; is BOS running inside its app?", 409);
      return validCandidate(reply.candidate);
    },
    async admit(mode: UpdateMode) {
      if (!options.port) throw err("this server is not running inside the desktop app; nothing to relaunch", 409);
      const reply = await request("admit", { mode }, timeouts.admit);
      if (!reply) throw err("the desktop did not answer the update admission", 409);
      if (reply.ok !== true) throw refusal(reply, "the desktop refused the update");
      return [];
    },
    async ports() {
      const ports = [options.serverPort];
      for (const port of options.extraPorts ?? []) if (await (options.checkPort ?? listening)(port)) ports.push(port);
      return ports;
    },
    async execute(plan: ExecutorPlan) {
      if (!options.port) throw err("this server is not running inside the desktop app; nothing to relaunch", 409);
      const reply = await request("execute", { plan }, timeouts.execute);
      // No answer after we asked is the ambiguous case: main may have
      // recorded its intent and be quitting us right now. Never retry.
      if (!reply) throw err("the desktop did not confirm the handoff", 409, { pending: true });
      if (reply.ok !== true) throw refusal(reply, "the desktop refused the handoff");
    },
  };
}
