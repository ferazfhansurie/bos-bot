import { afterEach, expect, it, vi } from "vitest";
import { hostedFreeTokenValid, registerHostedFree, verifyFreeModelKey } from "./free-model-setup.ts";
afterEach(()=>vi.unstubAllGlobals());
it("checks only the fixed official endpoint without redirects",async()=>{const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({data:{limit_remaining:0}}),{status:200}));vi.stubGlobal("fetch",fetcher);await verifyFreeModelKey("fixture-key");expect(fetcher.mock.calls[0][0]).toBe("https://openrouter.ai/api/v1/key");expect(fetcher.mock.calls[0][1]).toMatchObject({redirect:"error",headers:{Authorization:"Bearer fixture-key"}});});
it("never exposes a provider body or credential on failure",async()=>{vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response("fixture-private-key",{status:401})));await expect(verifyFreeModelKey("fixture-private-key")).rejects.toThrow("OpenRouter rejected this key");});
it("rejects blank and excessive keys without network",async()=>{const f=vi.fn();vi.stubGlobal("fetch",f);for(const key of ["", " ","a".repeat(513)])await expect(verifyFreeModelKey(key)).rejects.toThrow();expect(f).not.toHaveBeenCalled();});

it("rejects malformed successful auth responses",async()=>{for(const body of ["not json",JSON.stringify({error:{message:"secret"}}),JSON.stringify({data:[]}),"x".repeat(17000)]){vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(body)));await expect(verifyFreeModelKey("fixture-key")).rejects.toThrow("invalid connection response");}});
it("registers with BOS Free and validates the returned install token",async()=>{
 const f=vi.fn().mockResolvedValue(new Response(JSON.stringify({token:"bosf_"+"a".repeat(40)})));vi.stubGlobal("fetch",f);
 expect(await registerHostedFree("https://relay.invalid/api/v1")).toBe("bosf_"+"a".repeat(40));
 expect(f.mock.calls[0][0]).toBe("https://relay.invalid/api/v1/register");expect(f.mock.calls[0][1]).toMatchObject({method:"POST",redirect:"error"});
 for(const body of [JSON.stringify({token:"sk-or-leak"}),"nope",JSON.stringify({})]){vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(body)));await expect(registerHostedFree("https://relay.invalid/api/v1")).rejects.toThrow("invalid response");}
 vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response("",{status:429})));await expect(registerHostedFree("https://relay.invalid/api/v1")).rejects.toThrow("busy");
});
it("reuses only well-formed tokens the relay still accepts",async()=>{
 const f=vi.fn().mockResolvedValue(new Response("{}",{status:200}));vi.stubGlobal("fetch",f);
 expect(await hostedFreeTokenValid("https://relay.invalid/api/v1","bosf_"+"a".repeat(40))).toBe(true);
 expect(f.mock.calls[0][0]).toBe("https://relay.invalid/api/v1/usage");
 expect(await hostedFreeTokenValid("https://relay.invalid/api/v1","sk-or-owner")).toBe(false);expect(f).toHaveBeenCalledTimes(1);
 vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response("",{status:401})));expect(await hostedFreeTokenValid("https://relay.invalid/api/v1","bosf_"+"a".repeat(40))).toBe(false);
});
