import { describe, expect, it } from "vitest";
import { MOD_CSP } from "../../shared/mods";
import { WEBRTC_GLOBALS, modDocument, modHostDocument } from "./sandbox";

const bundle = {
  manifest: { id: "today", name: "Today", version: "1.0.0", description: "Test", surfaces: ["panel" as const], permissions: [] },
  files: { "index.html": `<script src="app.js"></script><p>hi</p>`, "app.js": `window.ran = "</script><b>x</b>";` },
};

describe("mod sandbox documents", () => {
  it("puts the CSP first and strips WebRTC before the sdk and mod code", () => {
    const doc = modDocument(bundle, "chan");
    expect(doc.indexOf(MOD_CSP)).toBeGreaterThan(0);
    expect(doc.indexOf(MOD_CSP)).toBeLessThan(doc.indexOf("<script"));
    const rtc = doc.indexOf("RTCPeerConnection");
    expect(rtc).toBeGreaterThan(0);
    expect(rtc).toBeLessThan(doc.indexOf("window.bos"));
    expect(rtc).toBeLessThan(doc.indexOf("window.ran"));
    for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel"]) expect(WEBRTC_GLOBALS).toContain(name);
  });

  it("inlines bundled scripts without letting them close the script tag", () => {
    const doc = modDocument(bundle, "chan");
    expect(doc).not.toContain(`src="app.js"`);
    expect(doc).toContain("<\\/script><b>x</b>");
  });

  it("nests mod code in a second opaque sandbox behind a frame-src policy", () => {
    const host = modHostDocument(bundle, "chan");
    expect(host).toContain(`<iframe sandbox="allow-scripts"`);
    expect(host).toContain("frame-src about:");
    expect(host).not.toContain("allow-same-origin");
    expect(host.slice(host.indexOf("srcdoc="), host.indexOf("></iframe>"))).not.toContain("<script");
  });
});
