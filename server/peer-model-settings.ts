/** Peer settings may edit their conversation, never the bot's authority or defaults. */
export function peerTaskPatchViolation(body: Record<string, unknown>): boolean {
  const allowed = new Set(['title','archivedAt','pinnedMessageId','modelSelection','requireAvailableModel','resetApprovalToAsk','updateBotDefault']);
  return Object.keys(body).some(key=>!allowed.has(key)) ||
    (body.updateBotDefault !== undefined && body.updateBotDefault !== false) ||
    (body.resetApprovalToAsk !== undefined && body.resetApprovalToAsk !== true) ||
    (body.resetApprovalToAsk === true && body.modelSelection === undefined);
}
/** Catalogs carry capabilities and model labels, never installation commands or credentials. */
export function peerModelCatalog<T extends {instanceId:string;driverKind:string;displayName:string;snapshot:{state:string;authenticated?:boolean;billing?:string};models:unknown;capabilities:unknown;access?:unknown;icon?:unknown}>(instances:T[]) {
  return instances.map(i=>({instanceId:i.instanceId,driverKind:i.driverKind,displayName:i.displayName,models:i.models,capabilities:i.capabilities,...(i.icon?{icon:i.icon}:{}),...(i.access?{access:i.access}:{}),snapshot:{state:i.snapshot.state,authenticated:i.snapshot.authenticated,billing:i.snapshot.billing}}));
}
