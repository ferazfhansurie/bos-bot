import { beforeEach, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { DATA_DIR } from "./config.ts";
import { Store } from "./store.ts";
import { BOS_STARTER } from "../shared/bos-onboarding.ts";
import { onboardingChief } from "./onboarding-chief.ts";
beforeEach(()=>rmSync(DATA_DIR,{recursive:true,force:true}));
const make=()=>new Store(()=>({instanceId:"fixture",model:"fixture"}));
it("reuses a renamed chief and preserves every existing profile",()=>{
 const store=make(); const chief=store.createBot({name:"My coordinator",soul:"Keep me"});store.setChiefOfStaff(chief.id);
 const before=JSON.stringify(store.bots);expect(onboardingChief(store,100).id).toBe(chief.id);expect(JSON.stringify(store.bots)).toBe(before);
});
it("creates BOS once without replacing ordinary bots or their conversations",()=>{
 const store=make();const original=store.createBot({name:"Original"});const before=JSON.stringify(original);
 const chief=onboardingChief(store,100);expect(chief.name).toBe("BOS");expect(chief.chiefOfStaff).toBe(true);
 expect(onboardingChief(store,100).id).toBe(chief.id);expect(store.bots).toHaveLength(2);expect(JSON.stringify(original)).toBe(before);
 expect(onboardingChief(make(),100).id).toBe(chief.id);
});
it("refuses capacity without mutation",()=>{const store=make();store.createBot();expect(()=>onboardingChief(store,1)).toThrow(/limit/);expect(store.bots).toHaveLength(1);});

it("never promotes an ordinary bot with the starter profile",()=>{const store=make();const ordinary=store.createBot(BOS_STARTER);const chief=onboardingChief(store,100);expect(chief.id).not.toBe(ordinary.id);expect(ordinary.chiefOfStaff).not.toBe(true);});
it("reuses its persisted chief even at capacity",()=>{const store=make();const chief=onboardingChief(store,1);expect(onboardingChief(make(),1).id).toBe(chief.id);});
it("rolls back an unpersisted chief and retries without a duplicate",()=>{
 const store=make();const original=store.createBot({name:"Existing"});
 const before=JSON.stringify(store.bots);
 const save=vi.spyOn(store as any,"saveBots").mockImplementationOnce(()=>{throw new Error("fixture disk full");});
 try{
  expect(()=>onboardingChief(store,2)).toThrow("fixture disk full");
  expect(JSON.stringify(store.bots)).toBe(before);
  expect(make().bots.map(bot=>bot.id)).toEqual([original.id]);
  const chief=onboardingChief(store,2);
  expect(store.bots).toHaveLength(2);
  expect(onboardingChief(make(),2).id).toBe(chief.id);
 }finally{save.mockRestore();}
});

it("new coordinator keeps the chosen free model for future threads",()=>{const store=make();const selection={instanceId:"bos-free",model:"openrouter/free"};const chief=onboardingChief(store,100,selection);expect(chief.modelSelection).toEqual(selection);expect(store.tasks(chief.id)[0].modelSelection).toEqual(selection);});
