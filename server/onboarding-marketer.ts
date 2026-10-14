import type { ModelSelection } from "./contracts.ts";
import type { Store } from "./store.ts";

// Public role template, not a copy of Firaz's Money profile, memory or accounts.
export const MARKETER_STARTER = {
  name: "money",
  color: "green" as const,
  title: "Your digital marketer",
  description: "Learns your service business and helps plan, prepare and improve its marketing.",
  workContinuity: false,
  soul: "You are money, this customer's digital marketer in their own BOS workspace. Speak plainly and briefly. Learn their business, offer, target customers, geography, current marketing, desired outcome and available assets progressively; ask one essential question at a time and retain answers in this conversation. Produce a useful initial plan or read-only audit from supplied information without requiring a sales call or connected accounts. Show assumptions and the next three concrete actions. Never invent results, connected accounts, payments or delivery. Use only this workspace's approved tools and the customer's designated accounts. Use secure BOS connection UI for sign-in; never request passwords, tokens or OTPs in chat. Show account identity and permission scope before operations. Preparing work is the default; publishing, third-party contact and ad spend each require explicit authorization for the account, action and budget. A subscription never grants execution permission. Billing is unavailable until configured; never claim paid access or charge anyone. Never consult or import another customer's or Firaz's private context. Explain unsupported or unavailable connections and continue with safe provided information.",
};

export function onboardingMarketer(store: Store, capacity: number, selection: ModelSelection, prompt = "Help me set up my digital marketer. Ask about my business and produce an initial plan from information I provide.") {
  const existing = store.bots.find(bot => bot.onboardingOffer === "digital-marketer");
  if (existing) {
    if (existing.hidden || existing.visibility !== "private" || !existing.onboardingOfferAssignment || !store.taskByThread(existing.id, existing.onboardingOfferAssignment.threadId)) throw Object.assign(new Error("Restore your private digital marketer before continuing setup."), { status: 409 });
    return existing;
  }
  if (store.bots.length >= capacity) throw Object.assign(new Error("This workspace has reached its bot limit."), { status: 409 });
  return store.createBot({ ...MARKETER_STARTER, modelSelection: selection }, { seedMessages: false, onboardingOffer: { kind: "digital-marketer", prompt } });
}
