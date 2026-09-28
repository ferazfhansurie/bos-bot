/** Auth-only check: no generation, payment or redirects, and no raw upstream errors. */
export async function verifyFreeModelKey(raw: unknown): Promise<string> {
 if (typeof raw!=="string" || !raw.trim() || raw.trim().length>512 || /[\r\n]/.test(raw)) throw Object.assign(new Error("Enter a valid OpenRouter API key."),{status:400});
 const key=raw.trim();
 let response:Response;
 try { response=await fetch("https://openrouter.ai/api/v1/key",{headers:{Authorization:`Bearer ${key}`},redirect:"error",signal:AbortSignal.timeout(10000)}); }
 catch {throw Object.assign(new Error("Could not reach OpenRouter. Try again."),{status:502});}
 if (!response.ok) throw Object.assign(new Error(response.status===401||response.status===403?"OpenRouter rejected this key. Check it and try again.":"OpenRouter is unavailable. Try again."),{status:response.status===401||response.status===403?400:502});
 try {
  const reader=response.body?.getReader();if(!reader)throw new Error();
  let size=0;const chunks:Uint8Array[]=[];
  try {while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>16384)throw new Error();chunks.push(part.value);}}
  finally {await reader.cancel();}
  const data=JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if(!data || data.error || !data.data || typeof data.data!=="object" || Array.isArray(data.data))throw new Error();
 } catch {throw Object.assign(new Error("OpenRouter returned an invalid connection response. Try again."),{status:502});}
 return key;
}
