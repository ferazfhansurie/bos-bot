import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("@/state/store", () => ({ api: vi.fn(), useStore: () => ({ dispatch: vi.fn() }) }));
import { RecoveryBannerView } from "./RecoveryBanner";
describe("startup recovery banner", () => {
  it("does not show a banner for healthy startup", () => {
    expect(renderToStaticMarkup(createElement(RecoveryBannerView, { status: { notices: [], safeMode: { enabled: false, reason: null } }, onOpen: vi.fn() }))).toBe("");
  });
  it("surfaces read-only data and safe mode before opening settings", () => {
    const html = renderToStaticMarkup(createElement(RecoveryBannerView, { status: { notices: [{ id: "n", collection: "bots.json", status: "read-only", detail: "Bots are read-only; your original data is preserved.", at: 1 }], safeMode: { enabled: true, reason: "Normal startup failed." } }, onOpen: vi.fn() }));
    for (const text of ["Bots are read-only", "Safe mode", "Normal startup failed", "Open health", 'role="alert"']) expect(html).toContain(text);
  });
  it("offers exit only when the desktop supplies an explicit safe-mode action", () => {
    const props = { status: { notices: [], safeMode: { enabled: true, reason: null } }, onOpen: vi.fn(), onExit: vi.fn() };
    const html = renderToStaticMarkup(createElement(RecoveryBannerView, props));
    expect(html).toContain("Exit safe mode");
  });
});
