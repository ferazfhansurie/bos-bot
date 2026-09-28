import { BOS_STARTER } from "../shared/bos-onboarding.ts";
import type { ModelSelection } from "./contracts.ts";
import type { Store } from "./store.ts";

/** Explicit owner setup action only. Never repurpose an existing bot. */
export function onboardingChief(store: Store, capacity: number, selection?: ModelSelection) {
 const existing = store.bots.find(bot=>bot.chiefOfStaff && !bot.hidden);
 if (existing) return existing;
 // Never elect over an existing hidden chief or silently change its authority.
 if (store.bots.some(bot=>bot.chiefOfStaff)) throw Object.assign(new Error("Show your existing coordinator before starting team setup."),{status:409});
 if (store.bots.length>=capacity) throw Object.assign(new Error("This workspace has reached its bot limit."),{status:409});
 // Profile and coordinator role share one persisted record; no name-based recovery.
 return store.createBot({...BOS_STARTER,...(selection?{modelSelection:selection}:{})},{seedMessages:false,chiefOfStaff:true});
}
