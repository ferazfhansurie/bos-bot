import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { HealthReport } from "../../shared/doctor";
vi.mock("@/state/store", () => ({ api: vi.fn(), useStore: () => ({ dispatch: vi.fn() }) }));
import { HealthReportView } from "./HealthSettings";
const report: HealthReport = { checkedAt: 1, checks: [
  { id: "engine", status: "ok", detail: "One engine ready." },
  { id: "push", status: "warning", detail: "Push is not set up on this BOS.", fix: { kind: "settings", section: "companion", label: "Open device settings" } },
], notices: [{ id: "n1", collection: "bots.json", status: "read-only", detail: "Bots are read-only while recovery needs attention.", at: 1 }], safeMode: { enabled: true, reason: "Normal startup failed." } };
describe("Settings health", () => {
  it("keeps settings navigation but hides repair actions outside the c1 rollout", () => {
    const html = renderToStaticMarkup(createElement(HealthReportView, { report: { ...report, selfHealEnabled: false, checks: [...report.checks,
      { id: "whatsapp", status: "warning", detail: "Disconnected", fix: { kind: "action", action: "reconnect-whatsapp", label: "Reconnect WhatsApp" } }] }, busy: false, onFix: vi.fn() }));
    expect(html).toContain("Open device settings");
    expect(html).not.toContain("Reconnect WhatsApp");
  });
  it("renders check status and recovery notices with safe actions", () => {
    const html = renderToStaticMarkup(createElement(HealthReportView, { report, busy: false, onFix: vi.fn() }));
    for (const text of ["Engine", "Ready", "Needs attention", "Push is not set up", "Open device settings", "Bots are read-only", "Safe mode", "Normal startup failed."]) expect(html).toContain(text);
    expect(html).not.toContain("delete-data");
  });
  it("disables fixes while a check or repair is in progress", () => {
    const html = renderToStaticMarkup(createElement(HealthReportView, { report, busy: true, onFix: vi.fn() }));
    expect(html).toMatch(/<button[^>]*disabled=""/);
  });
});
