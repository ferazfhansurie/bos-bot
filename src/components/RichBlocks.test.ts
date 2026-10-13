import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatMarkdown } from "./ChatMarkdown";
const render = (text: string, streaming = false) => renderToStaticMarkup(createElement(ChatMarkdown, {text, streaming}));
describe("dashboard blocks in bos", () => {
  it.each(["donut", "bar", "line", "area", "hbar"])("renders %s as a visual, never json code", type => {
    const html = render('```chart\n'+JSON.stringify({type,title:"Spend",xKey:"name",series:[{key:"value",label:"Spend"}],data:[{name:"KOL",value:50},{name:"Salary",value:20}]})+'\n```');
    expect(html).toContain('<figure'); expect(html).toContain('Spend'); expect(html).not.toContain('Copy code'); expect(html).not.toContain('&quot;type&quot;');
  });
  it("renders stat units and notes", () => {
    const html=render('```stats\n{"items":[{"label":"Spend","value":1234.5,"unit":"rm","note":"Year to date"},{"label":"Docs","value":23,"unit":"count"}]}\n```');
    expect(html).toContain('RM 1,234.50');expect(html).toContain('Year to date');expect(html).not.toContain('Copy code');
  });
  it("keeps malformed settled blocks inspectable but hides partial streaming json", () => {
    expect(render('```chart\n{"type":\n```')).toContain('Copy code');
    const html=render('```chart\n{"type":',true);expect(html).toContain('Preparing visual');expect(html).not.toContain('&quot;type&quot;');
  });
  it("aligns the entire numeric column including its header", () => {
    const html=render('| Category | Amount |\n| --- | --- |\n| KOL | RM 1,234.50 |\n| Salary | 25 |');
    expect(html).toMatch(/<th[^>]*!text-right[^>]*>Amount/);expect(html).toMatch(/<td[^>]*text-right[^>]*>RM 1,234.50/);
  });
});
