import type { FirstAssignment } from "../../shared/bos-onboarding.js";
import { BOS_ONBOARDING_VERSION } from "../../shared/bos-onboarding.js";

type Request = (path: string, options?: { method?: string; body?: string; timeoutMs?: number }) => Promise<any>;
/** Persist intent before touching a model or sending. Recovery always uses the
 * original thread and payload, even after the user selects another chat. */
export async function startFirstAssignment(request: Request, proposed?: FirstAssignment) {
  const current=await request("/api/config");
  const recovered: FirstAssignment | undefined=current.onboarding?.firstAssignment ?? proposed;
  if(!recovered)throw new Error("Connect a model before starting a new assignment.");
  let assignment: FirstAssignment=recovered;
  if(!current.onboarding?.firstAssignment){
    const saved=await request("/api/config",{method:"PUT",body:JSON.stringify({onboarding:{firstAssignment:assignment}}),timeoutMs:10000});
    assignment=saved.onboarding.firstAssignment;
  }
  if(!assignment.prepared){
    await request(`/api/bots/${encodeURIComponent(assignment.botId)}/tasks/${encodeURIComponent(assignment.threadId)}`,{method:"PATCH",body:JSON.stringify({modelSelection:assignment.selection,requireAvailableModel:true}),timeoutMs:10000});
    assignment={...assignment,prepared:true};
    await request("/api/config",{method:"PUT",body:JSON.stringify({onboarding:{firstAssignment:assignment}}),timeoutMs:10000});
  }
  await request(`/api/bots/${encodeURIComponent(assignment.botId)}/messages`,{method:"POST",body:JSON.stringify({text:assignment.text,threadId:assignment.threadId,sendId:assignment.sendId}),timeoutMs:20000});
  const config=await request("/api/config",{method:"PUT",body:JSON.stringify({onboarding:{completedAt:new Date().toISOString(),version:BOS_ONBOARDING_VERSION}}),timeoutMs:10000});
  return {config,assignment};
}
