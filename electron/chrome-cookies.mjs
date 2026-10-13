// Explicit, selected-profile macOS session import. Never log cookie values/keys.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createDecipheriv, createHash, pbkdf2Sync } from 'node:crypto';
const exec = promisify(execFile);
export function decryptChromeCookie(row, key, databaseVersion) {
  if (!row.encrypted_value?.length) return row.value || '';
  const bytes = Buffer.from(row.encrypted_value);
  if (bytes.subarray(0,3).toString() !== 'v10') throw new Error('Unsupported cookie encryption');
  const decipher=createDecipheriv('aes-128-cbc',key,Buffer.alloc(16,32));
  let plain=Buffer.concat([decipher.update(bytes.subarray(3)),decipher.final()]);
  if (databaseVersion >= 24) { const host=createHash('sha256').update(row.host_key).digest(); if(plain.length<32||!host.equals(plain.subarray(0,32)))throw new Error('Cookie origin did not match');plain=plain.subarray(32); }
  return plain.toString('utf8');
}
function cookieFile(directory) { return ['Network/Cookies','Cookies'].map(f=>path.join(directory,f)).find(f=>fs.existsSync(f)); }
export async function cookiePreview(directory) {
  const file=cookieFile(directory);if(!file)return {cookies:0,cookiesError:'No local chrome cookies available.'};
  if(process.platform!=='darwin')return {cookies:0,cookiesError:'Existing chrome logins can currently be imported on macOS only.'};
  try{const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(file,{readOnly:true});try{return {cookies:db.prepare('SELECT COUNT(*) AS count FROM cookies').get().count,cookiesError:''};}finally{db.close();}}
  catch{return {cookies:0,cookiesError:'Close chrome and preview again to import saved logins.'};}
}
export async function importChromeCookies(directory,ses,{getKey=async()=>{
  // The exact selected Chrome credential service, used only after native consent.
  const {stdout}=await exec('/usr/bin/security',['find-generic-password','-s','Chrome Safe Storage','-w'],{encoding:'utf8',timeout:30000,maxBuffer:8192});
  return pbkdf2Sync(stdout.replace(/\r?\n$/,''),'saltysalt',1003,16,'sha1');
}}={}){
  if(process.platform!=='darwin')throw new Error('Chrome login import is currently supported on macOS only');
  const file=cookieFile(directory);if(!file)throw new Error('Chrome cookie store is unavailable');
  const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(file,{readOnly:true});let rows,version;
  try{version=Number(db.prepare("SELECT value FROM meta WHERE key='version'").get()?.value)||0;const columns=new Set(db.prepare('PRAGMA table_info(cookies)').all().map(c=>c.name));rows=db.prepare(`SELECT host_key,name,value,encrypted_value,path,is_secure,is_httponly,CAST(expires_utc AS REAL) AS expires_utc,samesite${columns.has('top_frame_site_key')?',top_frame_site_key':''}${columns.has('is_partitioned')?',is_partitioned':''} FROM cookies LIMIT 10000`).all();}finally{db.close();}
  let key;try{key=await getKey();}catch{throw new Error('Chrome keychain access was not granted. Sign in again in bos, or retry the import.');}
  let imported=0,skipped=0;const existing=await ses.cookies.get({});const keys=new Set(existing.map(c=>`${c.domain}|${c.path}|${c.name}`));
  try{for(const row of rows){
    if(row.top_frame_site_key || row.is_partitioned){skipped++;continue;}
    if(keys.has(`${row.host_key}|${row.path}|${row.name}`)){skipped++;continue;}
    const expiry=Number(row.expires_utc)/1000000-11644473600;if(row.expires_utc&&expiry<=Date.now()/1000){skipped++;continue;}
    try{
      const value=decryptChromeCookie(row,key,version),host=row.host_key.replace(/^\./,'');if(!host||/[\s/@]/.test(host)){skipped++;continue;}
      const cookie={url:`${row.is_secure?'https':'http'}://${host}${row.path||'/'}`,...(row.host_key.startsWith('.')?{domain:row.host_key}:{}),name:row.name,value,path:row.path||'/',secure:Boolean(row.is_secure),httpOnly:Boolean(row.is_httponly),sameSite:({0:'no_restriction',1:'lax',2:'strict'})[row.samesite]??'unspecified',...(row.expires_utc?{expirationDate:expiry}:{})};
      await ses.cookies.set(cookie);keys.add(`${row.host_key}|${row.path}|${row.name}`);imported++;
    }catch{skipped++;}
  }await ses.cookies.flushStore();return {imported,skipped};}finally{key.fill(0);}
}
