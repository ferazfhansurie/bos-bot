import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ToolActivity } from "./ToolActivity";

describe("ToolActivity", () => {
  it("starts collapsed with an accessible status and escaped input/output", () => {
    const html = renderToStaticMarkup(createElement(ToolActivity, { tool: { name: "Bash", ok: true, input: "echo hi", output: "<script>unsafe()</script>" } }));
    expect(html).toContain("<details");
    expect(html).not.toContain(" open=");
    expect(html).toContain("Bash · Completed · Tool details");
    expect(html).toContain('role="button"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("echo hi");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });
  it("distinguishes pending, failed and unrecorded output", () => {
    const render = (ok?: boolean) => renderToStaticMarkup(createElement(ToolActivity, { tool: { name: "Read", ok } }));
    expect(render()).toContain("Waiting for the tool to finish");
    expect(render(false)).toContain("Failed");
    expect(render(false)).toContain("No output was recorded");
    expect(render(true)).toContain("No output was recorded");
  });
});

it("requires explicit finished-or-stopped confirmation for held outcome review", async () => {
 const { reviewPrivateTurnOutcome }=await import("./ToolActivity");
 const recovery={id:"receipt",botId:"bot",threadId:"thread"};let calls=0;let body;
 const request=async(_path:string,init?:RequestInit)=>{calls++;body=JSON.parse(String(init?.body));return {receipt:{...recovery,reviewedAt:123}};};
 await expect(reviewPrivateTurnOutcome(recovery,false,request)).rejects.toThrow(/Confirm/);expect(calls).toBe(0);
 expect(await reviewPrivateTurnOutcome(recovery,true,request)).toBe(123);expect(calls).toBe(1);expect(body).toEqual({confirmed:true});
 const html=renderToStaticMarkup(createElement(ToolActivity,{tool:{name:"Outcome unknown",ok:false,recovery}}));
 expect(html).toContain("I checked the outcome and that this request has finished or stopped");
 expect(html).toContain('type="checkbox"');expect(html).toContain("Mark reviewed");expect(html).toContain('disabled=""');
 const reviewed=renderToStaticMarkup(createElement(ToolActivity,{tool:{name:"Outcome unknown",ok:false,recovery:{...recovery,reviewedAt:123}}}));
 expect(reviewed).toContain("Outcome reviewed");expect(reviewed).not.toContain("Mark reviewed");
});
