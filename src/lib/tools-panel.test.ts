import { describe, expect, it } from "vitest";
import { browserAddress, browserSupported } from "./tools-panel";
describe("browser address", () => {
  it("accepts addresses and searches", () => {
    expect(browserAddress("example.com/path")).toBe("https://example.com/path");
    expect(browserAddress("https://example.com/path")).toBe("https://example.com/path");
    expect(browserAddress("two words")).toBe("https://www.google.com/search?q=two%20words");
    expect(browserAddress("about:blank")).toBe("about:blank");
  });
  it("refuses non-web schemes and credentials", () => {
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,test", "https://u:p@example.com", "", "about:config"]) expect(browserAddress(url)).toBeNull();
  });
});
describe("browser support", () => {
  it("needs the desktop shell's tools-browser partition", () => {
    expect(browserSupported({ toolsBrowserPartition: "persist:bos-tools-browser" })).toBe(true);
    expect(browserSupported({})).toBe(false);
    expect(browserSupported(undefined)).toBe(false);
  });
});
