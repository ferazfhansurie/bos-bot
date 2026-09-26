import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomic } from "./atomic.ts";

/** The local bot thread dedicated to one canonical shared room. */
export class SharedBotTasks {
  private readonly tasks = new Map<string, string>();
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
    if (!existsSync(file)) return;
    let saved: unknown;
    try { saved = JSON.parse(readFileSync(file, "utf8")); }
    catch { throw new Error("could not read shared bot tasks"); }
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) throw new Error("invalid shared bot tasks");
    for (const [key, threadId] of Object.entries(saved)) {
      if (!/^[\w-]+:[\w-]+$/.test(key) || typeof threadId !== "string" || !/^[\w-]+$/.test(threadId)) throw new Error("invalid shared bot task");
      this.tasks.set(key, threadId);
    }
  }

  get(roomId: string, botId: string): string | undefined { return this.tasks.get(`${roomId}:${botId}`); }

  set(roomId: string, botId: string, threadId: string): void {
    const key = `${roomId}:${botId}`;
    if (!/^[\w-]+:[\w-]+$/.test(key) || !/^[\w-]+$/.test(threadId)) throw new Error("invalid shared bot task");
    const previous = this.tasks.get(key);
    this.tasks.set(key, threadId);
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      writeFileAtomic(this.file, JSON.stringify(Object.fromEntries(this.tasks)), { mode: 0o600 });
    } catch (error) {
      if (previous) this.tasks.set(key, previous);
      else this.tasks.delete(key);
      throw error;
    }
  }
}
