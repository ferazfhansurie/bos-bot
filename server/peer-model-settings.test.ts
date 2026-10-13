import {expect,it} from 'vitest';
import {peerModelCatalog,peerTaskPatchViolation} from './peer-model-settings.ts';
it('exposes only model capabilities, without account emails, commands or configuration',()=>{
 const rows=peerModelCatalog([{instanceId:'claude',driverKind:'claudeAgent',displayName:'Personal',snapshot:{state:'available',authenticated:true,account:{email:'fixture-only@example.test'},version:'fixture'},models:{default:'sonnet',options:[]},capabilities:{images:true},install:{signInCommand:'fixture secret command'},cli:'/private/fixture/cli',claudeAccount:{configDir:'/private/fixture'}}]);
 expect(rows).toEqual([{instanceId:'claude',driverKind:'claudeAgent',displayName:'Personal',snapshot:{state:'available',authenticated:true,billing:undefined},models:{default:'sonnet',options:[]},capabilities:{images:true}}]);
});
it('allows conversation model changes while refusing authority, default or transport changes',()=>{
 expect(peerTaskPatchViolation({modelSelection:{instanceId:'claude',model:'sonnet'},resetApprovalToAsk:true,updateBotDefault:false})).toBe(false);
 for(const body of [{updateBotDefault:true},{approvalMode:'full'},{autoApprove:true},{projectId:'owner'},{surface:'local'},{channelTransport:'discord'},{resetApprovalToAsk:true},{requireAvailableModel:false,modelSelection:{instanceId:'claude',model:'sonnet'},alwaysAllow:['*']}])expect(peerTaskPatchViolation(body)).toBe(true);
});
