import { expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectSharedBotReply } from "./shared-bot-reply.ts";
import { openMessageFile, sharedFileReplyText } from "./message-file.ts";
import { SharedAttachmentStore } from "./shared-attachment-store.ts";

it("publishes images and linked files from this turn, refusing private files, symlinks and code samples", async () => {
 const dir = mkdtempSync(join(tmpdir(), "bos-room-reply-"));
 try {
  const room = join(dir,"room"), images = join(dir,"images"); mkdirSync(room); mkdirSync(images);
  const doc=join(room,"brief.pdf"), png=join(images,"picture.png"), secret=join(dir,"private.txt"), link=join(room,"leak.txt");
  writeFileSync(doc,"%PDF-1.4\nfixture"); writeFileSync(png,Buffer.from([137,80,78,71,13,10,26,10])); writeFileSync(secret,"PRIVATE"); symlinkSync(secret,link);
  const calls: string[]=[];
  const result=await collectSharedBotReply([
   {id:"u",role:"user",kind:"text",text:`[private](${secret})`},
   {id:"image",role:"bot",kind:"text",attachments:[{kind:"image",path:png}]},
   {id:"final",role:"bot",kind:"text",turnTerminal:true,text:`[brief](${doc}) [private](${secret}) [link](${link})\n\n\`[code](/do-not-read)\` [web](https://example.com/x)`}
  ],async (_message,href,generated)=> {
   calls.push(href); const file=await openMessageFile(href,[generated?images:room]);
   try{return {name:file.name,mime:file.mime,data:(await file.handle.readFile()).toString("base64")};}finally{await file.handle.close();}
  });
  expect(result.files?.map(f=>f.name)).toEqual(["picture.png","brief.pdf"]);
  expect(result.reply).toContain("Some files could not be shared"); expect(result.reply).not.toContain(secret);
  expect(calls).not.toContain("/do-not-read"); expect(calls).not.toContain("https://example.com/x");
  const store=new SharedAttachmentStore(join(dir,"published"));
  for(const file of result.files!){const attachment=store.save("room-1","home:bot:test",file.name,file.mime,file.data); expect(store.get("room-1",attachment.id)?.data).toBe(file.data); expect(store.get("room-2",attachment.id)).toBeNull();}
 }finally{rmSync(dir,{recursive:true,force:true});}
});

it("supports attachment-only final replies and caps the number of published files",async()=>{
 const attachments=Array.from({length:6},(_,i)=>({kind:"image",path:`/image-${i}.png`}));
 const result=await collectSharedBotReply([{id:"final",role:"bot",kind:"text",turnTerminal:true,attachments}],async(_m,path)=>({name:path,mime:"image/png",data:"eA=="}));
 expect(result.files).toHaveLength(4); expect(result.reply).toContain("Some files");
 const only=await collectSharedBotReply([{id:"f",role:"bot",kind:"text",turnTerminal:true,attachments:attachments.slice(0,1)}],async()=>({name:"x.png",mime:"image/png",data:"eA=="}));
 expect(only.reply).toBe("Files attached.");
});

it("does not let a failed earlier Markdown path suppress a later generated image capability", async () => {
 const result = await collectSharedBotReply([
  { id: "earlier", role: "bot", kind: "text", text: "![image](/attachments/pic.png)" },
  { id: "final", role: "bot", kind: "text", turnTerminal: true, attachments: [{ kind: "image", path: "/attachments/pic.png" }] }
 ], async (_message, _href, generated) => {
  if (!generated) throw new Error("outside room root");
  return { name: "pic.png", mime: "image/png", data: "eA==" };
 });
 expect(result.files).toHaveLength(1); expect(result.reply).toBe("Files attached.");
});

it("removes nested local targets without leaving dead images or host paths", () => {
 expect(sharedFileReplyText("[![preview](/room/image.png)](/room/report.pdf)")).toBe("preview");
 expect(sharedFileReplyText("[report][file]\n\n[file]: /room/report.pdf")).toBe("report");
 expect(sharedFileReplyText("[web](https://example.com) and `[example](/room/example.txt)`")).toBe("[web](https://example.com) and `[example](/room/example.txt)`");
});

it("persists generated text artifacts as room-owned downloadable copies", async () => {
 const dir = mkdtempSync(join(tmpdir(), "bos-generated-room-files-"));
 try {
  const result = await collectSharedBotReply([{id:"final",role:"bot",kind:"text",turnTerminal:true,text:'ready\n\n```bos-artifacts\n{"files":[{"name":"brief.md","content":"# fixture\\nroom only"}]}\n```'}],async()=>{throw new Error("no filesystem read authorized");});
  expect(result.reply).toBe("ready");
  const store = new SharedAttachmentStore(dir);
  const file = result.files![0]!;
  const attachment = store.save("room-1", "home:bot:test", file.name, file.mime, file.data);
  const reloaded = new SharedAttachmentStore(dir);
  expect(Buffer.from(reloaded.get("room-1", attachment.id)!.data, "base64").toString()).toBe("# fixture\nroom only");
  expect(reloaded.get("other-room", attachment.id)).toBeNull();
 } finally { rmSync(dir,{recursive:true,force:true}); }
});
