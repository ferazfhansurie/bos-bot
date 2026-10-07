/** Local-only entrypoint. This module is never imported by src/index.ts. */
import { createWorker } from './index';
import { createAuth } from './auth';
import { readConfig } from './config';
import { errorResponse, json } from './http';
import type { OTPEmailInput } from './email';
const codes = new Map<string, OTPEmailInput>();
const fictional = (email: unknown): email is string => typeof email === 'string' && /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@example\.test$/i.test(email) && email.length<=254;
function loopbackOrigin(value: string) {
  const url = new URL(value);
  if (url.protocol!=='http:' || !['127.0.0.1','localhost','[::1]'].includes(url.hostname) || url.origin!==value) throw new Error('local loopback origin required');
  return url.origin;
}
function localConfig(env: Env) {
  const authBaseURL = loopbackOrigin(env.BETTER_AUTH_URL);
  const allowedOrigins = new Set([authBaseURL,...env.ALLOWED_ORIGINS.split(',').filter(Boolean).map(loopbackOrigin)]);
  const config = readConfig({...env,BETTER_AUTH_URL:'https://issuer.example.test',ALLOWED_ORIGINS:''});
  return {...config,authBaseURL,allowedOrigins};
}
const worker = createWorker(async () => {throw new Error('no external control-plane effects in local dev');},
  (env,ctx,config,requestId)=>createAuth(env,ctx,config,requestId,{
    secureCookies:false,
    async sendOTP(input) {
      if (!fictional(input.email)) throw new Error('fictional accounts only');
      if(codes.size>=256) codes.clear();
      codes.set(input.email.toLowerCase(),input);
    },
  }),localConfig);
export default {
  async fetch(request: Request,env: Env,ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (!['127.0.0.1','localhost','[::1]'].includes(url.hostname)) return errorResponse(403,'forbidden');
    if (url.pathname==='/__dev/otp' && request.method==='GET') {
      // No CORS: only local operator tooling can read a code, never a renderer origin.
      if (request.headers.has('origin')) return errorResponse(403,'forbidden');
      const email = url.searchParams.get('email');
      if (!fictional(email)) return errorResponse(400,'invalid_email');
      const code = codes.get(email.toLowerCase());
      return code ? json({...code}) : errorResponse(404,'not_found');
    }
    if (request.method==='POST' && ['/api/auth/email-otp/send-verification-otp','/api/auth/sign-in/email-otp'].includes(url.pathname)) {
      let value: any;
      try {value=await request.clone().json();} catch {return errorResponse(400,'invalid_request');}
      if (!fictional(value?.email)) return errorResponse(400,'invalid_email');
    }
    return worker.fetch(request,env,ctx);
  },
};
