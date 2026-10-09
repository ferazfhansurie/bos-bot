import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ActivityMascot } from "./ActivityMascot";
import { flatMascotBody } from "../../shared/flat-mascot-bodies";

const render = (bot: Parameters<typeof ActivityMascot>[0]["bot"], gesture: Parameters<typeof ActivityMascot>[0]["gesture"] = "working") =>
  renderToStaticMarkup(createElement(ActivityMascot, { bot, gesture }));

describe("ActivityMascot", () => {
  it("wears the bot's own body in the full-body engine and names the gesture", () => {
    const html = render({ name: "bos", color: "blue", mascotBody: "star" });
    expect(html).toContain('data-gesture="working"');
    expect(html).toContain(flatMascotBody("star").path);
    expect(html).toContain("#377FE6");
    expect(html).toContain('aria-label="bos"');
    expect(html).not.toContain("bot-morph");
  });

  it("wears the glyph face for the gesture, accent and all, in any colour", () => {
    const html = render({ name: "bos", color: "#7C3AED", mascotBody: "circle" }, "thinking");
    expect(html).toContain('data-glyph-face="thinking"');
    expect(html).toContain('data-glyph-accent="query"');
    expect(html).toContain("#7C3AED");
    expect(render({ name: "bos", color: "blue" }, "finished")).toContain('data-glyph-face="finished"');
  });

  it("keeps the ring eyes for a bot that picked another eye style", () => {
    const html = render({ name: "bos", color: "blue", mascotEyes: "round" });
    expect(html).not.toContain("data-glyph-face");
  });

  it("keeps an uploaded photo and gives it the breathing squash instead", () => {
    const html = render({ name: "bos", color: "blue", avatarUrl: "/api/attachments/cat.webp", avatarCrop: "circle" }, "thinking");
    expect(html).toContain("bot-morph");
    expect(html).toContain("<img");
    expect(html).not.toContain("data-gesture");
  });
});
