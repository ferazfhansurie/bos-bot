import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ banner: null as null | { id: string; text: string; url: string } }));
vi.mock("@/lib/app-config", () => ({ useAppConfig: () => ({ banner: fixture.banner }) }));
const { ProductBanner } = await import("./ProductBanner");
it("stays absent until there is a configured banner", () => {
  fixture.banner = null;
  expect(renderToStaticMarkup(createElement(ProductBanner))).toBe("");
});
it("renders configured text as escaped prose and a new-tab link", () => {
  fixture.banner = { id: "notice", text: "Try <BOS> today", url: "https://bosbot.my/get" };
  const html = renderToStaticMarkup(createElement(ProductBanner));
  expect(html).toContain("Try &lt;BOS&gt; today");
  expect(html).toContain('href="https://bosbot.my/get"');
  expect(html).toContain('rel="noreferrer"');
});
