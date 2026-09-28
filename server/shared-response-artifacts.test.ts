import { expect, it } from "vitest";
import { parseSharedResponseArtifacts } from "./shared-response-artifacts.ts";
import { collectSharedBotReply } from "./shared-bot-reply.ts";
const block = (files: unknown) => `\`\`\`bos-artifacts\n${JSON.stringify({ files })}\n\`\`\``;
it("creates bounded text files without reading host paths, and removes the transport block", () => {
 const result = parseSharedResponseArtifacts(`ready\n\n${block([{ name: "brief.md", content: "# Brief\nhello" }, { name: "rows.csv", content: "name,value\na,2" }])}`);
 expect(result.text.trim()).toBe("ready"); expect(result.rejected).toBe(false);
 expect(result.files.map(f => f.mime)).toEqual(["text/markdown", "text/csv"]);
 expect(Buffer.from(result.files[0]!.data, "base64").toString()).toBe("# Brief\nhello");
});
it.each(["../secret.txt", "/tmp/a.txt", "a\\b.txt", "a.html", "a.svg", "a.png", "a.sh", "a\u0000.txt"])("refuses unsafe artifact name %s", name => {
 expect(parseSharedResponseArtifacts(block([{ name, content: "x" }]))).toMatchObject({ files: [], rejected: true });
});
it("rejects oversized utf8 bytes, too many files, executable content and malformed json", () => {
 for (const files of [ [{name:"a.txt",content:"é".repeat(32769)}], Array.from({length:5}, (_,i)=>({name:`a${i}.txt`,content:"x"})), [{name:"a.txt",content:"#!/bin/sh"}], [{name:"a.json",content:"invalid"}], [{name:"a.txt",content:"a\u0000b"}] ]) {
  expect(parseSharedResponseArtifacts(block(files))).toMatchObject({files:[],rejected:true});
 }
 expect(parseSharedResponseArtifacts("```bos-artifacts\n{broken}\n```")).toMatchObject({files:[],rejected:true,text:""});
});
it("does not interpret quoted or nested protocol examples", () => {
 const quoted = block([{name:"example.txt",content:"x"}]).split("\n").map(line=>`> ${line}`).join("\n");
 expect(parseSharedResponseArtifacts(quoted)).toMatchObject({files:[],rejected:false,text:quoted});
});
it("creates artifacts only from the terminal current turn and never follows paths inside content", async () => {
 const result = await collectSharedBotReply([
  {id:"early",role:"bot",kind:"text",text:block([{name:"early.txt",content:"early"}])},
  {id:"final",role:"bot",kind:"text",turnTerminal:true,text:block([{name:"final.md",content:"[private](/private/path)"}])},
 ], async()=>{ throw new Error("must not read"); });
 expect(result.files?.map(f=>f.name)).toEqual(["final.md"]); expect(result.reply).toBe("Files attached.");
});
it("rejects multiple envelopes and duplicate names atomically", () => {
 expect(parseSharedResponseArtifacts(`${block([{name:"a.txt",content:"a"}])}\n${block([{name:"b.txt",content:"b"}])}`)).toMatchObject({files:[],rejected:true});
 expect(parseSharedResponseArtifacts(block([{name:"a.txt",content:"a"},{name:"A.txt",content:"b"}]))).toMatchObject({files:[],rejected:true});
});
it("shares the four-file cap with generated images and signals rejected protocol", async () => {
 const result=await collectSharedBotReply([{id:"final",role:"bot",kind:"text",turnTerminal:true,text:block(Array.from({length:4},(_,i)=>({name:`file${i}.txt`,content:"x"}))),attachments:[{kind:"image",path:"/image.png"}]}],async()=>{throw new Error("cap should prevent read");});
 expect(result.files).toHaveLength(4); expect(result.reply).toContain("Some files could not be shared");
 const rejected=await collectSharedBotReply([{id:"final",role:"bot",kind:"text",turnTerminal:true,text:block([{name:"bad.png",content:"x"}])}],async()=>{throw new Error("must not read");});
 expect(rejected.files).toBeUndefined(); expect(rejected.reply).toContain("format or size was unsupported"); expect(rejected.reply).not.toContain("bos-artifacts");
});
