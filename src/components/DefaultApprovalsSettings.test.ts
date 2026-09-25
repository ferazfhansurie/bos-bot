// The workspace-wide permission defaults. Two things matter here: the screen
// shows what the server actually has (not a hopeful local default), and each
// control patches only its own field, so saving one never resends — or
// silently resets — the other.
import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  approvals: undefined as { defaultMode?: string; keepAcrossModelSwitch?: boolean } | undefined,
  // useState lives in a fixture so a handler can be called after the render
  // that produced it, the way a click does.
  values: [] as unknown[],
  index: 0,
  dispatch: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) fixture.values[index] = typeof initial === "function" ? initial() : initial;
    return [
      fixture.values[index],
      (next: unknown) => {
        fixture.values[index] = typeof next === "function" ? next(fixture.values[index]) : next;
      },
    ];
  },
}));
vi.mock("@/state/store", () => ({
  api: vi.fn(),
  useStore: () => ({ state: { config: { approvals: fixture.approvals } }, dispatch: fixture.dispatch }),
}));

const { api } = await import("@/state/store");
const { DefaultApprovalsSettings } = await import("./DefaultApprovalsSettings");

type Node = ReactElement<{
  children?: ReactNode;
  "aria-label"?: string;
  onChange?: (event: unknown) => void;
  onClick?: () => void;
}>;

function nodes(value: ReactNode): Node[] {
  if (!isValidElement(value)) return [];
  const node = value as Node;
  return [node, ...Children.toArray(node.props.children).flatMap(nodes)];
}

/** `fresh` keeps the component's own state between renders, so a re-render
 * sees what a handler just set — the way the live screen does. */
function render(fresh = true) {
  fixture.index = 0;
  if (fresh) fixture.values = [];
  let tree: ReactNode;
  function Capture() {
    tree = DefaultApprovalsSettings();
    return tree;
  }
  const html = renderToStaticMarkup(createElement(Capture));
  return { html, tree: nodes(tree) };
}

function control(tree: Node[], label: string): Node {
  const node = tree.find((candidate) => candidate.props["aria-label"] === label);
  if (!node) throw new Error(`no control labelled ${label}`);
  return node;
}

const MODE_LABEL = "Default approval level for new bots";
const KEEP_LABEL = "Keep full access when switching models";

beforeEach(() => {
  vi.mocked(api).mockReset();
  vi.mocked(api).mockResolvedValue({ approvals: { defaultMode: "full" } });
  fixture.dispatch.mockReset();
  fixture.approvals = undefined;
});

describe("DefaultApprovalsSettings", () => {
  it("falls back to today's behavior when the server has no defaults yet", () => {
    const { html } = render();
    expect(html).toContain('value="ask" selected=""');
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain("Default for new bots");
    expect(html).toContain(KEEP_LABEL);
    expect(html).toContain("including bots a Chief of Staff creates");
  });

  it("shows the value the server confirmed", () => {
    fixture.approvals = { defaultMode: "auto", keepAcrossModelSwitch: true };
    const { html } = render();
    expect(html).toContain('value="auto" selected=""');
    expect(html).not.toContain('value="ask" selected=""');
    expect(html).toContain('aria-checked="true"');
  });

  it("offers the shared mode labels and keeps Codex-only Custom out of a workspace default", () => {
    const { html } = render();
    expect(html).toContain("Ask for approval");
    expect(html).toContain("Auto-accept edits");
    expect(html).toContain("Approve for me");
    expect(html).toContain("Full access");
    expect(html).not.toContain("Custom (config.toml)");
  });

  it("still shows a Custom default that was already saved", () => {
    fixture.approvals = { defaultMode: "custom" };
    expect(render().html).toContain('value="custom" selected=""');
  });

  it("patches only the default mode when the selector changes", async () => {
    const { tree } = render();
    control(tree, MODE_LABEL).props.onChange?.({ target: { value: "full" } });
    await vi.waitFor(() => expect(api).toHaveBeenCalled());
    expect(vi.mocked(api).mock.calls[0]?.[0]).toBe("/api/config");
    const init = vi.mocked(api).mock.calls[0]?.[1];
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(String(init?.body))).toEqual({ approvals: { defaultMode: "full" } });
    await vi.waitFor(() =>
      expect(fixture.dispatch).toHaveBeenCalledWith({
        type: "configStatus",
        config: { approvals: { defaultMode: "full" } },
      }),
    );
  });

  it("patches only the model-switch flag when the toggle is used", async () => {
    const { tree } = render();
    control(tree, KEEP_LABEL).props.onClick?.();
    await vi.waitFor(() => expect(api).toHaveBeenCalled());
    expect(JSON.parse(String(vi.mocked(api).mock.calls[0]?.[1]?.body))).toEqual({
      approvals: { keepAcrossModelSwitch: true },
    });
  });

  it("turns the model-switch flag back off", async () => {
    fixture.approvals = { keepAcrossModelSwitch: true };
    const { tree } = render();
    control(tree, KEEP_LABEL).props.onClick?.();
    await vi.waitFor(() => expect(api).toHaveBeenCalled());
    expect(JSON.parse(String(vi.mocked(api).mock.calls[0]?.[1]?.body))).toEqual({
      approvals: { keepAcrossModelSwitch: false },
    });
  });

  it("reports a failed save instead of pretending it stuck", async () => {
    vi.mocked(api).mockRejectedValue(new Error("server said no"));
    const first = render();
    control(first.tree, KEEP_LABEL).props.onClick?.();
    await vi.waitFor(() => expect(api).toHaveBeenCalled());
    await vi.waitFor(() => expect(render(false).html).toContain("server said no"));
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });
});
