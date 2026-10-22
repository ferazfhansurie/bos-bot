import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ProductFeedback } from "./ProductFeedback";

vi.mock("@/state/store", () => ({ api: vi.fn() }));

describe("feedback consent form", () => {
  it("starts with an empty note and unchecked opt-in", () => {
    const html = renderToStaticMarkup(createElement(ProductFeedback));
    expect(html).toContain("Share this note with Firaz");
    expect(html).toContain("</textarea>");
    expect(html).not.toContain("checked=");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Send feedback/);
  });
  it("rating consent does not offer to transmit any message content", () => {
    const html = renderToStaticMarkup(createElement(ProductFeedback, { rating: "down" }));
    expect(html).toContain("Share this rating with Firaz");
    expect(html).toContain("No message text, message ID or conversation");
    expect(html).not.toContain("textarea");
    expect(html).not.toContain("checked=");
  });
});
