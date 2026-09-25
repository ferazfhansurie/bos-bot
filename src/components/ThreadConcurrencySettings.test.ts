import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ThreadConcurrencySettings } from "./ThreadConcurrencySettings";

const fixture = vi.hoisted(() => ({ limit: undefined as number | undefined, shared: undefined as boolean | undefined }));
vi.mock("@/state/store", () => ({
  api: vi.fn(),
  useStore: () => ({
    state: { config: { threads: fixture.limit === undefined ? undefined : { maxConcurrentPerBot: fixture.limit, parallelProjectFolder: fixture.shared } } },
    dispatch: vi.fn(),
  }),
}));

describe("ThreadConcurrencySettings", () => {
  it("keeps three as the legacy default and offers one through ten", () => {
    fixture.limit = undefined;
    fixture.shared = undefined;
    const markup = renderToStaticMarkup(createElement(ThreadConcurrencySettings));
    expect(markup).toContain('value="3" selected=""');
    expect(markup.match(/<option /g)).toHaveLength(10);
    expect(markup).toContain('value="10"');
    expect(markup).toContain("Extra messages queue until a slot opens.");
    expect(markup).toContain("Maximum running threads per bot");
  });
  it("shows the confirmed server value", () => {
    fixture.limit = 10;
    fixture.shared = undefined;
    expect(renderToStaticMarkup(createElement(ThreadConcurrencySettings))).toContain('value="10" selected=""');
  });
  it("shows shared project folders on by default, including on a config written before the setting existed", () => {
    fixture.limit = 3;
    fixture.shared = undefined;
    const markup = renderToStaticMarkup(createElement(ThreadConcurrencySettings));
    expect(markup).toContain('id="thread-shared-folder" type="checkbox"');
    expect(markup).toContain('checked=""');
    expect(markup).toContain("Share one project folder between a bot&#x27;s threads");
  });
  it("shows the toggle off when the server confirms the opt-out", () => {
    fixture.limit = 3;
    fixture.shared = false;
    const markup = renderToStaticMarkup(createElement(ThreadConcurrencySettings));
    expect(markup).toContain('id="thread-shared-folder"');
    expect(markup).not.toContain('checked=""');
  });
});
