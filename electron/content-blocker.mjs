import fs from 'node:fs';
import path from 'node:path';
import { FiltersEngine, Request } from './vendor/adblock-engine.mjs';

const hostname = value => { try { const u=new URL(value);return /^https?:$/.test(u.protocol)?u.hostname.toLowerCase():''; } catch {return '';} };
export function createContentBlocker({root,filters,contentsFromId=()=>null}) {
  const engine=FiltersEngine.parse(filters); const counts=new Map(),cssKeys=new Map(),settingsCache=new Map();
  const file=id=>{if(!/^[a-zA-Z0-9-]+$/.test(id))throw new Error('Invalid profile');return path.join(root,`${id}.blocker.json`);};
  const read=id=>{file(id);if(settingsCache.has(id))return settingsCache.get(id);try{const data=JSON.parse(fs.readFileSync(file(id),'utf8'));const settings={enabled:data.enabled!==false,disabledSites:Array.isArray(data.disabledSites)?data.disabledSites.filter(x=>typeof x==='string').slice(0,1000):[]};settingsCache.set(id,settings);return settings;}catch{const settings={enabled:true,disabledSites:[]};settingsCache.set(id,settings);return settings;}};
  const save=(id,data)=>{fs.mkdirSync(root,{recursive:true,mode:0o700});const dest=file(id);fs.writeFileSync(dest+'.tmp',JSON.stringify(data),{mode:0o600});fs.renameSync(dest+'.tmp',dest);};
  const status=(id,guest)=>{const settings=read(id),site=hostname(guest?.getURL());return {...settings,site,siteEnabled:settings.enabled&&!settings.disabledSites.includes(site),blocked:counts.get(guest?.id)||0};};
  const clearCSS=async guest=>{const key=cssKeys.get(guest.id);cssKeys.delete(guest.id);if(key)try{await guest.removeInsertedCSS(key);}catch{}};
  const apply=async(id,guest)=>{
    await clearCSS(guest); const state=status(id,guest); if(!state.site||!state.siteEnabled||guest.isDestroyed())return;
    const url=guest.getURL(),r=Request.fromRawDetails({url,sourceUrl:url,type:'mainFrame'});
    const {styles}=engine.getCosmeticsFilters({url,hostname:r.hostname,domain:r.domain,getBaseRules:true,getRulesFromHostname:true,getInjectionRules:false,getExtendedRules:false});
    if(styles&&guest.getURL()===url&&!guest.isDestroyed()){const key=await guest.insertCSS(styles,{cssOrigin:'user'});if(guest.getURL()===url)cssKeys.set(guest.id,key);else await guest.removeInsertedCSS(key);}
  };
  return {status,apply,
    shouldBlock(id,details) {
      if(details.resourceType==='mainFrame'||!hostname(details.url))return false;
      const guest=contentsFromId(details.webContentsId),settings=read(id);
      const source=guest?.getURL()||details.referrer;const site=hostname(source);
      if(!settings.enabled||!site||settings.disabledSites.includes(site))return false;
      const blocked=engine.match(Request.fromRawDetails({url:details.url,sourceUrl:source,type:details.resourceType||'other',requestId:String(details.id),tabId:details.webContentsId})).match===true;
      if(blocked&&guest)counts.set(guest.id,(counts.get(guest.id)||0)+1);return blocked;
    },
    async toggle(id,guest,{enabled,siteOnly=false}) {
      if(typeof enabled!=='boolean')throw new Error('Choose whether blocking is enabled');
      const settings={...read(id),disabledSites:[...read(id).disabledSites]};if(siteOnly){const site=hostname(guest?.getURL());if(!site)throw new Error('Open a website first');settings.disabledSites=settings.disabledSites.filter(x=>x!==site);if(!enabled)settings.disabledSites.push(site);}else settings.enabled=enabled;
      save(id,settings);settingsCache.set(id,settings);if(guest)await apply(id,guest);return status(id,guest);
    },
    forget(guest){counts.delete(guest.id);cssKeys.delete(guest.id);},
  };
}
