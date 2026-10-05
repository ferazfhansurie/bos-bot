import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AppState } from "@/state/store";

const fixture = vi.hoisted(() => ({ state: {} as Partial<AppState>, dispatch: vi.fn() }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: { ...original.initialState, ...fixture.state }, dispatch: fixture.dispatch }) };
});

import { NeedsMeNavRow } from "./NeedsMe";

const render = (state: Partial<AppState>, density: "comfortable" | "icons" = "comfortable") => {
  fixture.state = state;
  return renderToStaticMarkup(createElement(NeedsMeNavRow, { density }));
};

describe("needs-me sidebar row", () => {
  it("hides the badge when nothing is waiting", () => {
    const html = render({ inboxCount: 0 });
    expect(html).toContain("Needs me");
    expect(html).not.toContain("bg-accent");
  });

  it("shows the count, capped, in both densities", () => {
    expect(render({ inboxCount: 3 })).toContain(">3</span>");
    expect(render({ inboxCount: 3 })).toContain('aria-label="Needs me, 3 waiting"');
    expect(render({ inboxCount: 250 }, "icons")).toContain(">99+</span>");
  });

  it("marks itself active on the needs-me view", () => {
    expect(render({ activeView: "needs-me" })).toContain("bg-raised text-ink");
    expect(render({ activeView: "chat" })).not.toContain("bg-raised text-ink");
  });
});
