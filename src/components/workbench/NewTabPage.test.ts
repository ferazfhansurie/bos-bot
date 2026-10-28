import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { NewTabPage } from "@/components/workbench/NewTabPage";

describe("new tab apps", () => {
  const apps = [{ id: "a-abcdefabcdef", name: "bos bot data", icon: "star" }];
  it("offers rename and delete on each app when the owner can change them", () => {
    const html = renderToStaticMarkup(createElement(NewTabPage, { onPick: () => undefined, apps: { apps, open: () => undefined, rename: async () => undefined, remove: async () => undefined } }));
    expect(html).toContain("bos bot data options");
  });
  it("shows a plain row when the app can't be changed here", () => {
    const html = renderToStaticMarkup(createElement(NewTabPage, { onPick: () => undefined, apps: { apps, open: () => undefined } }));
    expect(html).toContain("bos bot data");
    expect(html).not.toContain("bos bot data options");
  });
});
