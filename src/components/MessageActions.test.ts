import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MessageActions } from "./MessageActions";

type Props = Parameters<typeof MessageActions>[0];

const render = (props: Partial<Omit<Props, "children">> = {}) =>
  renderToStaticMarkup(
    createElement(MessageActions, {
      side: "bot",
      ...props,
      children: [
        createElement("button", { type: "button", key: "copy" }, "copy"),
        createElement("button", { type: "button", key: "reply" }, "reply"),
      ],
    }),
  );

describe("MessageActions", () => {
  it("shows grok's hover row: react, reply and a menu holding the rest", () => {
    const html = render({ onReply: () => {}, onReact: () => {} });
    expect(html).toContain('aria-label="React"');
    expect(html).toContain('aria-label="Reply to message"');
    expect(html).toContain('aria-label="Message actions"');
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain("opacity-0");
    expect(html).toContain("group-hover:opacity-100");
    // the rest sits in the menu, hidden until asked for
    expect(html).toMatch(/role="menu"[^>]*hidden=""[\s\S]*>copy</);
    expect(html).not.toContain('data-open="true"');
  });

  it("drops react and reply when the message cannot take them", () => {
    const html = render();
    expect(html).not.toContain('aria-label="React"');
    expect(html).toContain('aria-label="Message actions"');
  });

  it("stays visible with its controls inline while one must remain reachable", () => {
    const html = render({ forceOpen: true });
    expect(html).toContain('data-open="true"');
    expect(html).toContain(">copy<");
    expect(html).not.toContain('role="menu"');
    expect(html).not.toContain("opacity-0");
  });

  it("mirrors the row on the user side so react stays nearest the bubble", () => {
    expect(render({ side: "user" })).toContain("flex-row-reverse");
    expect(render({ side: "bot" })).not.toContain("flex-row-reverse");
  });
});
