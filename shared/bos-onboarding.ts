export const BOS_ONBOARDING_VERSION = 1;
export const BOS_STARTER = {
  name: "BOS",
  title: "Your first AI teammate",
  description: "Helps you do the work, recruit specialists and build your AI team.",
  soul: "You are BOS, the user's first AI teammate and team coordinator. Understand their business and customers, then help finish one useful task. You can do the work yourself or propose a specialist for ongoing ownership using the authorized team setup tools. Carry the user's brief into the specialist's first assignment; do not ask them to repeat it. Ask at most one essential question at a time. Show a real preview or file and invite one concrete revision. Never claim a result was created, tested or published without evidence. Explain missing tools or model access plainly. Do not spend, publish, send messages to third parties or connect accounts without the user's authorization. Keep setup optional and respect existing approvals.",
};
export const FIRST_OUTCOMES = [
  { id: "website", title: "A website for my business", deliverable: "an editable website preview with content tailored to my customers" },
  { id: "dashboard", title: "A dashboard for my work", deliverable: "a working dashboard prototype using clearly labelled sample data" },
  { id: "crm", title: "A CRM for my sales process", deliverable: "a CRM prototype for my sales stages using sample contacts; explain what remains before production use" },
  { id: "motion", title: "A motion graphic for my brand", deliverable: "a short motion graphic preview using available tools; explain any rendering limitation before promising an export" },
] as const;
export interface BusinessBrief { business: string; customers: string; outcome: string; approach: "bos" | "specialist" }
export function firstAssignment(brief: BusinessBrief): string {
  const outcome=FIRST_OUTCOMES.find(item=>item.id===brief.outcome);
  if(!brief.business.trim() || !brief.customers.trim() || !outcome) throw new Error("Describe your business, customers and first outcome.");
  return `Let's set up my AI team and complete our first assignment.\n\nMy business: ${brief.business.trim().slice(0,1000)}\nMy customers: ${brief.customers.trim().slice(0,500)}\nFirst outcome: ${outcome.deliverable}.\n\n${brief.approach === "specialist" ? "Carry out the setup now: inspect the current team and reuse a suitable specialist, or recruit one specialist using the authorized team setup tools. Choose a clear name and role suited to this outcome and include the business, customers and first deliverable in their instructions. Keep my current coordinator and existing team intact. Follow the tool result: if setup is applied, use coordinate_bots to give that specialist the complete brief and ask them to start the first useful task; if it is pending review, show the proposal and wait for that decision. Do not stop at recommending a role or claiming a teammate exists. If team setup or delegation tools are unavailable, explain the limitation and start the useful task yourself with available tools." : "Work with me directly as my team coordinator. Suggest a specialist only when ongoing ownership would help."}\nAsk one essential question if needed, otherwise start. Use only available tools and my existing permissions. Show a real result, explain what you verified, then guide me through one revision. Do not publish, spend or contact anyone without asking.`;
}

export interface FirstAssignment {
  prepared?: boolean;
  botId: string;
  threadId: string;
  sendId: string;
  text: string;
  selection: { instanceId: string; model: string };
}
