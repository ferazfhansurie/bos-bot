import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";
it("persists eye choices through paired profile scope and refuses invalid choices", async () => {
 const fixture = await launchVerificationServer();
 const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(fixture.info.url + path, { method, headers: { "content-type":"application/json", origin:fixture.info.url }, ...(body === undefined ? {} : { body:JSON.stringify(body) }), signal:AbortSignal.timeout(10000) });
  return { status:r.status, body:await r.json() as any };
 };
 try {
  const made=await api("POST","/api/bots",{name:"Eye fixture",modelSelection:{instanceId:"claude",model:"claude-sonnet-5"},requireAvailableModel:true});
  expect(made.status).toBe(201);const id=made.body.bot.id;
  for(const mascotEyes of ["glyph","classic","round","arches","angled"]) {
   const saved=await api("PATCH",`/api/bots/${id}/profile`,{mascotEyes});
   expect(saved.status,mascotEyes).toBe(200);expect(saved.body.bot.mascotEyes).toBe(mascotEyes);
  }
  expect((await api("GET","/api/bots")).body.bots.find((b:any)=>b.id===id).mascotEyes).toBe("angled");
  expect((await api("PATCH",`/api/bots/${id}/profile`,{mascotEyes:"unknown"})).status).toBe(400);
  expect((await api("PATCH",`/api/bots/${id}/profile`,{mascotEyes:"round",approvalMode:"full"})).status).toBe(400);
  expect((await api("PATCH",`/api/bots/${id}`,{mascotEyes:"unknown"})).status).toBe(400);
 } finally { await fixture.close(); }
},45000);
