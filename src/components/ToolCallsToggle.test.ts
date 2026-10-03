import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const toggleState = vi.hoisted(() => ({ enabled: false, saving: false, error: "", toggle: async () => {} }));
vi.mock("@/hooks/use-tool-calls-toggle", () => ({ useToolCallsToggle: () => toggleState }));
vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({}) }));

const { ToolCallsToggle } = await import("./GroupView");

const render = (patch: Partial<typeof toggleState>) => {
  Object.assign(toggleState, { enabled: false, saving: false, error: "" }, patch);
  return renderToStaticMarkup(createElement(ToolCallsToggle));
};

describe("room tool calls toggle", () => {
  it("starts hidden and offers to show them", () => {
    const markup = render({});
    expect(markup).toContain('aria-label="Show tool calls"');
    expect(markup).toContain('aria-pressed="false"');
  });

  it("reads as on once the person has turned tool calls on", () => {
    const markup = render({ enabled: true });
    expect(markup).toContain('aria-label="Hide tool calls"');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain("text-accent");
  });

  it("can't be pressed twice while the setting saves, and surfaces a failed save", () => {
    expect(render({ saving: true })).toContain("disabled");
    const failed = render({ error: "Could not save the tool-call setting." });
    expect(failed).toContain('title="Could not save the tool-call setting."');
    expect(failed).toContain("text-danger");
  });
});
