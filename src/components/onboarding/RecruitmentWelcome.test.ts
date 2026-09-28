import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";

const fixture=vi.hoisted(()=>({state:{config:{onboarding:{}} as any,instances:[] as any[]},dispatch:vi.fn()}));
vi.mock("@/state/store",()=>({useStore:()=>fixture,api:vi.fn(),openThread:vi.fn()}));
vi.mock("@/components/Avatar",()=>({MausAvatar:()=>createElement("span",null,"BOS mascot")}));
vi.mock("@/components/EngineLibrary",()=>({engineReady:(instance:any)=>instance.ready}));
vi.mock("./beats/EnginesBeat",()=>({EnginesBeat:()=>createElement("div",null,"provider setup")}));
const {RecruitmentWelcome}=await import("./RecruitmentWelcome");
const bot:any={id:"bos",threadId:"thread",name:"BOS",modelSelection:{instanceId:"fixture"}};
beforeEach(()=>{fixture.state.config={onboarding:{}};fixture.state.instances=[];});
it("guides a new business toward four concrete outcomes without pretending setup is complete",()=>{
  const html=renderToStaticMarkup(createElement(RecruitmentWelcome,{bot,onDone:()=>{}}));
  for(const text of ["What does your business do?","Who do you help?","A website for my business","A dashboard for my work","A CRM for my sales process","A motion graphic for my brand","Set up later"])expect(html).toContain(text);
  expect(html).toMatch(/<button[^>]*disabled[^>]*>Find my first teammate/);
});
it("keeps recovery and provider setup available with no currently ready provider",()=>{
  fixture.state.config={onboarding:{businessBrief:{business:"Bakery",customers:"Families",outcome:"website",approach:"bos"},firstAssignment:{botId:"bos",threadId:"old",sendId:"onboarding_old",text:"original",selection:{instanceId:"gone",model:"old"},prepared:true}}};
  const html=renderToStaticMarkup(createElement(RecruitmentWelcome,{bot,onDone:()=>{}}));
  expect(html).toMatch(/<button(?![^>]*\sdisabled=)[^>]*>Resume my first assignment/);
  expect(html).toMatch(/<button(?![^>]*\sdisabled=)[^>]*>Back/);
  expect(html).toContain("Bakery");
});
