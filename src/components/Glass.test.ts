import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Glass } from "./Glass";

describe("Glass", () => {
  it("renders exactly the wrapped element while v3 is off", () => {
    const html = renderToStaticMarkup(
      createElement(Glass, { className: "conversation-composer rounded-[28px]", "data-tour": "composer", bezel: 18 } as never, "hi"),
    );
    expect(html).toBe('<div class="conversation-composer rounded-[28px]" data-tour="composer">hi</div>');
  });

  it("keeps the tag it was asked for", () => {
    const html = renderToStaticMarkup(createElement(Glass, { as: "aside", fallback: "solid", "aria-label": "sidebar" } as never));
    expect(html).toBe('<aside aria-label="sidebar"></aside>');
  });
});
