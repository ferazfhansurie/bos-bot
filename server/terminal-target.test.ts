import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { resolveTerminalTarget } from "./terminal-target.ts";
it("resolves bot and room thread folders without accepting a different thread", () => {
  const dir = mkdtempSync(join(tmpdir(),"terminal-target-"));
  try {
    const bot: any = {id:"bot",cwd:dir,tasks:[{threadId:"thread",resumeCursors:{}}]};
    const room: any = {id:"room",threadId:"room-thread",cwd:dir};
    const task: any = {threadId:"room-thread"};
    const store: any = {bot:(id:string)=>id==="bot"?bot:null, group:(id:string)=>id==="room"?room:null,
      taskByThread:(_id:string,t:string)=>bot.tasks.find((x:any)=>x.threadId===t),
      groupTaskByThread:(_id:string,t:string)=>t===task.threadId?task:null};
    expect(resolveTerminalTarget(store,"bot","thread")).toBe(realpathSync(dir));
    expect(resolveTerminalTarget(store,"room","room-thread")).toBe(realpathSync(dir));
    expect(()=>resolveTerminalTarget(store,"bot","room-thread")).toThrow();
    expect(()=>resolveTerminalTarget(store,"room","thread")).toThrow();
    bot.tasks[0].cwd = null;
    expect(resolveTerminalTarget(store,"bot","thread")).toBe(realpathSync(homedir()));
    bot.sharedWorkComputer = {id:"remote"};
    expect(()=>resolveTerminalTarget(store,"bot","thread")).toThrow(/local/i);
    delete bot.sharedWorkComputer; bot.computer="cloud";
    expect(()=>resolveTerminalTarget(store,"bot","thread")).toThrow(/local/i);
    delete bot.computer; bot.tasks[0].surface="vm";
    expect(()=>resolveTerminalTarget(store,"bot","thread")).toThrow(/local/i);
    delete bot.tasks[0].surface;
    expect(()=>resolveTerminalTarget(store,"bot","thread",()=>true)).toThrow(/local/i);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
