import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatMarkdown } from "@/components/ChatMarkdown";
import { smartUiKey } from "@/components/SmartUiBlock";
import { SMART_UI_EXAMPLE } from "./prompt";
import { assistantText, drawable, SmartUi } from "./SmartUi";

const draw = (code: string, streaming = false, theme: "light" | "dark" = "light") =>
  renderToStaticMarkup(createElement(SmartUi, { code, streaming, theme, fallback: createElement("p", null, "FALLBACK") }));

describe("smart ui renderer", () => {
  it("draws the skill's example as real components", () => {
    const html = draw(SMART_UI_EXAMPLE);
    expect(html).toContain('class="bos-openui"');
    expect(html).toContain("iui-stat");
    expect(html).toContain("Aina");
    expect(html).toContain("Chase the open ones");
    expect(html).not.toContain("FALLBACK");
  });

  it("follows the skin's scheme", () => {
    expect(draw(SMART_UI_EXAMPLE, false, "dark")).toContain('data-theme="dark"');
  });

  it("falls back to the code when a settled block draws nothing", () => {
    expect(drawable("this is not openui")).toBe(false);
    expect(draw("this is not openui")).toBe("<p>FALLBACK</p>");
    expect(draw('root = Col([Nope("x")])')).toContain("bos-openui");
  });

  it("draws a block cut off mid-stream without falling back", () => {
    for (const cut of [10, 60, SMART_UI_EXAMPLE.indexOf("chart =") + 20, SMART_UI_EXAMPLE.length - 30]) {
      const html = draw(SMART_UI_EXAMPLE.slice(0, cut), true);
      expect(html).not.toContain("FALLBACK");
      expect(html).toContain("bos-openui");
    }
  });

  it("posts a button's message, with Form values written out", () => {
    expect(assistantText({ type: "continue_conversation", params: {}, humanFriendlyMessage: "chase them" })).toBe("chase them");
    expect(assistantText({
      type: "continue_conversation", params: {}, humanFriendlyMessage: "book it", formName: "f",
      formState: { f: { date: { value: "2026-10-22", componentType: "DatePicker" }, note: { value: "" } } },
    })).toBe("book it\n\ndate: 2026-10-22");
  });

  it("keys block state by the code, stably", () => {
    expect(smartUiKey(SMART_UI_EXAMPLE)).toBe(smartUiKey(SMART_UI_EXAMPLE));
    expect(smartUiKey(SMART_UI_EXAMPLE)).toMatch(/^b[0-9a-z]{1,13}$/);
    expect(smartUiKey("a")).not.toBe(smartUiKey("b"));
  });
});

describe("chat markdown with smart ui", () => {
  const md = (text: string, streaming = false) => renderToStaticMarkup(createElement(ChatMarkdown, { text, streaming }));
  it("hands openui and openui-lang fences to the lazy renderer, never as code", () => {
    for (const tag of ["openui", "openui-lang"]) {
      const html = md(`numbers:\n\n\`\`\`${tag}\n${SMART_UI_EXAMPLE}\n\`\`\``);
      expect(html).toContain("Drawing…");
      expect(html).not.toContain("Copy code");
    }
  });
  it("leaves every other block exactly as before", () => {
    expect(md("```ts\nconst a = 1\n```")).toContain("Copy code");
    expect(md("```ts\nconst a = 1\n```")).not.toContain("bos-openui");
  });
});
