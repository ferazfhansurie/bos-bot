import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import type { Bot, InstanceInfo } from '@/state/store';
const fixture=vi.hoisted(()=>({calls:0,instances:[] as InstanceInfo[]}));
vi.mock('react',async(importOriginal)=>{
 const actual=await importOriginal<typeof import('react')>();
 return {...actual,useState:(initial:unknown)=>actual.useState(fixture.calls++===0?true:initial)};
});
vi.mock('@/state/store',()=>({useStore:()=>({state:{instances:fixture.instances,modelVariantSessions:{}},dispatch:vi.fn(),refreshInstances:vi.fn(),refreshModels:vi.fn()}),currentTaskBot:vi.fn()}));
vi.mock('./onboarding/FreeModelSetup',()=>({FreeModelSetup:()=>createElement('section',{'aria-label':'Free connection'},'Connect or reconnect OpenRouter')}));
vi.mock('./EngineSetup',()=>({EngineSetup:()=>createElement('div',null,'Generic CLI setup'),EngineUpdateNotice:()=>null,needsCli:(i:InstanceInfo)=>i?.snapshot.state!=='available',needsSignIn:(i:InstanceInfo)=>i?.snapshot.authenticated===false}));
import { ModelPicker,ModelEngineRail } from './ModelPicker';
const free:InstanceInfo={instanceId:'bos-free',driverKind:'openrouter-free',displayName:'BOS Free',access:'custom',snapshot:{state:'available'},models:{default:'example/model:free',options:[{id:'example/model:free',label:'Example model',custom:true}]}};
const bot:Bot={id:'b',threadId:'t',name:'BOS',title:'',description:'',notifications:true,color:'green',unread:false,modelSelection:{instanceId:'bos-free',model:'example/model:free'},messages:[]};
beforeEach(()=>{fixture.calls=0;fixture.instances=[free];});
it('renders free cloud catalog in the picker without local model controls',()=>{
 const html=renderToStaticMarkup(createElement(ModelPicker,{bot}));
 expect(html).toContain('data-model-picker-content');expect(html).toContain('Example model');
 expect(html).toContain('OpenRouter · Free');expect(html).toContain('Free cloud models');
 expect(html).toContain('Connect or reconnect OpenRouter');
 expect(html).not.toContain('Local');expect(html).not.toContain('Generic CLI setup');
});
it('unavailable free provider renders dedicated connection instead of generic CLI setup',()=>{
 fixture.instances=[{...free,snapshot:{state:'unavailable',reason:'key required'},models:{default:'openrouter/free',options:[]}}];
 const html=renderToStaticMarkup(createElement(ModelPicker,{bot}));
 expect(html).toContain('Connect or reconnect OpenRouter');expect(html).not.toContain('Generic CLI setup');expect(html).not.toContain('Local');
});
it('free provider remains visible on cloud rail beside supported subscriptions',()=>{
 const codex={...free,instanceId:'codex',driverKind:'codex',displayName:'Codex',access:'subscription' as const};
 const html=renderToStaticMarkup(createElement(ModelEngineRail,{instances:[free,codex],selectedInstance:free,onSelect:vi.fn()}));
 expect(html).toContain('Cloud');expect(html).toContain('aria-label="BOS Free"');expect(html).toContain('aria-label="Codex"');expect(html).not.toContain('Local');
});
