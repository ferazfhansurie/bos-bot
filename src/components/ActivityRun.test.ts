import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Message } from "@/state/store";
import { ActivityRun } from "./ActivityRun";

const step = (name: string, ok?: boolean): Message => ({ id: name, at: 1, role: "bot", kind: "activity", tool: { name, ok } });

describe("ActivityRun", () => {
  it("keeps running work visible in the closed group header without claiming completion", () => {
    const html = renderToStaticMarkup(createElement(ActivityRun, { messages: [step("Read", true), step("Bash")], children: "recorded details" }));
    expect(html).toContain("Running · Bash");
    expect(html).toContain('data-running="true"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("recorded details");
    expect(html).not.toContain("text-success");
  });
  it("reveals steps for search navigation and retains a controlled disclosure target", () => {
    const html = renderToStaticMarkup(createElement(ActivityRun, { messages: [step("Read", true), step("Bash", true)], forceOpen: true, children: "recorded details" }));
    expect(html).toContain("2 steps · Read, Bash");
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("aria-controls=");
    expect(html).toContain("recorded details");
    expect(html).not.toContain('data-running="true"');
  });
});
