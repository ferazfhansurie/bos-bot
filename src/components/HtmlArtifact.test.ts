import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatMarkdown } from "./ChatMarkdown";
import { ARTIFACT_CSP, artifactDocument } from "./HtmlArtifact";

const render = (text: string, streaming = false) => renderToStaticMarkup(createElement(ChatMarkdown, { text, streaming }));

describe("html artifacts", () => {
  it.each(["html", "artifact", "HTML"])("renders a ```%s block as a scripts-only sandboxed preview", lang => {
    const html = render("```" + lang + "\n<h1>Hi</h1><script>document.body.append('x')</script>\n```");
    expect(html).toContain("<iframe");
    expect(html).toMatch(/sandbox="allow-scripts"/);
    expect(html).not.toMatch(/allow-same-origin|allow-popups|allow-forms|allow-top-navigation/);
    expect(html).toContain("View source");
    expect(html).toContain("sandboxed, offline");
  });
  it("shows the growing source while the message streams, never a half-run page", () => {
    const html = render("```html\n<h1>Hi", true);
    expect(html).not.toContain("<iframe");
    expect(html).toContain("&lt;h1&gt;Hi");
  });
  it("puts a no-network CSP ahead of the bot's markup", () => {
    const doc = artifactDocument("<!DOCTYPE html><meta http-equiv=refresh content='0;url=https://evil.example'><img src=https://evil.example/x.png>", "f1");
    expect(doc.indexOf("Content-Security-Policy")).toBeLessThan(doc.indexOf("evil.example"));
    expect(doc.match(/<!doctype/gi)).toHaveLength(1);
    for (const directive of ["default-src 'none'", "connect-src 'none'", "frame-src 'none'", "img-src data: blob:", "form-action 'none'", "base-uri 'none'"]) expect(ARTIFACT_CSP).toContain(directive);
    expect(ARTIFACT_CSP).not.toMatch(/https?:|\*/);
    expect(doc).toContain("RTCPeerConnection");
  });
  it("keeps other code blocks as code", () => {
    expect(render("```ts\nconst a = 1\n```")).not.toContain("<iframe");
  });
});
