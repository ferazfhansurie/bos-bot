import { describe, expect, it } from "vitest";
import { firstAssignment, FIRST_OUTCOMES } from "./bos-onboarding";

describe("first business assignment", () => {
  const brief={business:"A software agency",customers:"local restaurants",outcome:"website",approach:"specialist" as const};
  it("carries the business into a bounded specialist assignment",()=>{
    const text=firstAssignment(brief);
    expect(text).toContain(brief.business);expect(text).toContain(brief.customers);
    expect(text).toContain("recruit one specialist");expect(text).toContain("one revision");
    expect(text).toContain("Carry out the setup now");
    expect(text).toContain("coordinate_bots");
    expect(text).toContain("pending review");
    expect(text).toContain("reuse a suitable specialist");
    expect(text).toContain("Do not publish, spend or contact anyone without asking");
  });
  it("lets BOS own the work directly and states prototype limits",()=>{
    for(const outcome of FIRST_OUTCOMES.filter(item=>item.id!=="digital-marketer")){
      const text=firstAssignment({...brief,outcome:outcome.id,approach:"bos"});
      expect(text).toContain("Work with me directly as my team coordinator");expect(text).toContain(outcome.deliverable);
    }
  });
  it("starts a private marketer intake without claiming paid access or requiring accounts",()=>{
    const text=firstAssignment({...brief,outcome:"digital-marketer"});
    expect(text).toContain(brief.business);expect(text).toContain(brief.customers);
    expect(text).toContain("initial marketing audit or plan");expect(text).toContain("Account connections can come later");
    expect(text).toContain("one essential question at a time");
    expect(text).not.toContain("coordinate_bots");
  });
  it("rejects missing context and unknown outcomes",()=>{
    for(const patch of [{business:" "},{customers:""},{outcome:"unknown"}])expect(()=>firstAssignment({...brief,...patch})).toThrow();
  });
});
