/** Real entrypoint: no fixture, stub issuer or dev sign-in routes in this graph. */
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { Database } from './db.ts';
import { CloudService } from './service.ts';
import { ControlPlaneIssuer } from './identity.ts';
import { startCloud } from './http.ts';
export async function startRealCloud(config: {databaseURL:string;issuerURL:string;serviceURL:string;key:Buffer;allowedOrigins?:string[]}) {
  const url = new URL(config.serviceURL);
  const db = new URL(config.databaseURL);
  if (url.protocol!=='http:' || url.hostname!=='127.0.0.1' || !url.port || url.origin!==config.serviceURL || db.hostname!=='127.0.0.1' || !db.pathname.startsWith('/cloud_slice'))
    throw new Error('slice 2 only: throwaway localhost service/database');
  const service=new CloudService(new Database(config.databaseURL),new ControlPlaneIssuer(config.issuerURL,config.serviceURL),config.serviceURL,config.key);
  return startCloud(service,Number(url.port),'127.0.0.1',undefined,true,new Set([config.serviceURL,...config.allowedOrigins ?? []]));
}
if(process.argv[1] && resolve(process.argv[1])===new URL(import.meta.url).pathname) {
  const databaseURL=process.env.CLOUD_DATABASE_URL,issuerURL=process.env.CLOUD_ISSUER_URL,serviceURL=process.env.CLOUD_SERVICE_URL;
  if(!databaseURL || !issuerURL || !serviceURL) throw new Error('CLOUD_DATABASE_URL, CLOUD_ISSUER_URL, CLOUD_SERVICE_URL required');
  const app=await startRealCloud({databaseURL,issuerURL,serviceURL,key:randomBytes(32),allowedOrigins:(process.env.CLOUD_ALLOWED_ORIGINS??'').split(',').filter(Boolean)});
  console.log(JSON.stringify({url:app.url,issuer:issuerURL}));
  let closing=false;
  for(const signal of ['SIGTERM','SIGINT'] as const) process.on(signal,()=>{if(closing)return;closing=true;void app.close().then(()=>process.exit(0));});
}
