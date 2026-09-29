import { it, expect } from "vitest";
import { WorkspaceBackupMaintenance } from "./workspace-backup-maintenance.ts";
import { DesktopUpdateLifecycle } from "./desktop-update-lifecycle.ts";
it("requires desktop authority and matching child identity, fences cancellation", async () => {
 const gate = new WorkspaceBackupMaintenance(); const saved: unknown[] = [];
 const life = new DesktopUpdateLifecycle(gate, 123, { idle: () => true, pause: () => {}, resume: () => {}, flush: async () => {} }, async r => { saved.push(r); }, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
 await expect(life.handle(false, { action: "prepare", expectedPid: 123, nonce: "abcdefghijklmnop" })).rejects.toMatchObject({ status: 403 });
 await expect(life.handle(true, { action: "prepare", expectedPid: 124, nonce: "abcdefghijklmnop" })).rejects.toMatchObject({ status: 409 });
 const receipt = await life.handle(true, { action: "prepare", expectedPid: 123, nonce: "abcdefghijklmnop" });
 expect(receipt).toMatchObject({ pid: 123, nonce: "abcdefghijklmnop", state: "prepared" });
 await expect(life.handle(true, { action: "cancel", expectedPid: 123, nonce: "different-operation" })).rejects.toMatchObject({ status: 409 });
 expect(gate.active).toBe(true);
 await life.handle(true, { action: "cancel", expectedPid: 123, nonce: "abcdefghijklmnop" });
 expect(gate.active).toBe(false); expect(saved).toHaveLength(2);
});
it("failed cancellation persistence keeps the workspace held", async () => {
 const gate = new WorkspaceBackupMaintenance(); let fail = false;
 const life = new DesktopUpdateLifecycle(gate, 123, { idle: () => true, pause: () => {}, resume: () => {}, flush: async () => {} }, async () => { if(fail) throw new Error("disk full"); }, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
 await life.handle(true, { action: "prepare", expectedPid: 123, nonce: "abcdefghijklmnop" }); fail = true;
 await expect(life.handle(true, { action: "cancel", expectedPid: 123, nonce: "abcdefghijklmnop" })).rejects.toThrow("disk full"); expect(gate.active).toBe(true);
});
it("retains and repairs prepared intent when parent commits during cancellation persistence", async () => {
 const gate=new WorkspaceBackupMaintenance(); let committed=false; const saved:any[]=[];
 const life=new DesktopUpdateLifecycle(gate,123,{idle:()=>true,pause:()=>{},resume:()=>{},flush:async()=>{}},async receipt=>{saved.push(receipt);if(receipt.state==="cancelled")committed=true;},"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",null,()=>{if(committed)throw new Error("parent committed");});
 await life.handle(true,{action:"prepare",expectedPid:123,nonce:"abcdefghijklmnop"});
 await expect(life.handle(true,{action:"cancel",expectedPid:123,nonce:"abcdefghijklmnop"})).rejects.toThrow("parent committed");
 expect(gate.active).toBe(true);expect(saved.at(-1).state).toBe("prepared");
});
it("serializes commit against cancel and keeps committed ownership held", async () => {
 const gate=new WorkspaceBackupMaintenance();let finish!:()=>void;let started!:()=>void;
 const wait=new Promise<void>(r=>{finish=r;}), entered=new Promise<void>(r=>{started=r;});
 const life=new DesktopUpdateLifecycle(gate,123,{idle:()=>true,pause:()=>{},resume:()=>{},flush:async()=>{}},async receipt=>{if(receipt.state==="committed"){started();await wait;}},"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
 const command={expectedPid:123,nonce:"abcdefghijklmnop"};await life.handle(true,{...command,action:"prepare"});
 const commit=life.handle(true,{...command,action:"commit"});await Promise.race([entered,commit]);
 await expect(life.handle(true,{...command,action:"cancel"})).rejects.toMatchObject({status:409});
 finish();expect(await commit).toMatchObject({state:"committed"});
 await expect(life.handle(true,{...command,action:"cancel"})).rejects.toMatchObject({status:409});expect(gate.active).toBe(true);
});
it("refuses a late commit from an already cancelled prepare", async () => {
 const gate=new WorkspaceBackupMaintenance();const life=new DesktopUpdateLifecycle(gate,123,{idle:()=>true,pause:()=>{},resume:()=>{},flush:async()=>{}},async()=>{},"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
 const command={expectedPid:123,nonce:"abcdefghijklmnop"};await life.handle(true,{...command,action:"prepare"});await life.handle(true,{...command,action:"cancel"});
 await expect(life.handle(true,{...command,action:"commit"})).rejects.toMatchObject({status:409});expect(gate.active).toBe(false);
});
