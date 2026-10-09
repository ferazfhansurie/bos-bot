import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  BotAvatar,
  MausAvatar,
  resolveBotAvatarOutcome,
  type BotAvatarProps,
  type MausAvatarProps,
} from "./Avatar";
import { MASCOT_BODY_IDS } from "../../shared/mascot-bodies";
import { PICKABLE_STATES } from "@/lib/mascot";
import { GLYPH_PATHS, glyphStateFor } from "../../shared/glyph-faces";

const render = (props: Partial<MausAvatarProps>) =>
  renderToStaticMarkup(createElement(MausAvatar, { color: "green", animated: false, ...props }));

const renderBot = (bot: Partial<BotAvatarProps["bot"]>) =>
  renderToStaticMarkup(
    createElement(BotAvatar, { bot: { color: "green", ...bot }, animated: false }),
  );

describe("MausAvatar body", () => {
  it("renders a different outline for every body", () => {
    const paths = MASCOT_BODY_IDS.filter(id => id !== "shield" && id !== "diamond").map(bodyId => render({ bodyId }).match(/<path d="([^"]+)"/)?.[1]);
    expect(new Set(paths).size).toBe(40);
  });
  it("wears the glyph face its state maps to", () => {
    for (const state of PICKABLE_STATES) {
      expect(render({ state })).toContain(`data-glyph-face="${glyphStateFor(state)}"`);
    }
    expect(render({})).toContain('data-glyph-face="idle"');
    expect(render({ state: "working", face: "failed" })).toContain('data-glyph-face="failed"');
  });

  it("draws the eyes from the shared glyph paths, in the ink the body needs", () => {
    const markup = render({ face: "working", size: 96 });
    expect(markup.split(GLYPH_PATHS.plus).length - 1).toBe(2);
    expect(markup).toContain(`data-glyph-accent="code"`);
    expect(markup).toContain("stroke:#000000");
    expect(render({ color: "#1E1E2E", face: "idle" })).toContain("stroke:#FFFFFF");
  });

  it("hides the accent on sidebar-sized faces", () => {
    expect(render({ face: "working", size: 20 })).not.toContain("data-glyph-accent");
    expect(render({ face: "working", size: 30 })).toContain('data-glyph-accent="code"');
  });

  it("keeps the old two-stroke face for a bot that picked another eye style", () => {
    const markup = render({ face: "working", eyes: "classic" });
    expect(markup).not.toContain("data-glyph-face");
    expect(markup).toContain("M 51 43 L 54 52");
  });

  it("takes any #RRGGBB as the body colour", () => {
    expect(render({ color: "#7c3aed" })).toContain('fill="#7C3AED"');
    expect(render({ color: "nope" as never })).toContain('fill="#009957"');
  });
  it("uses the selected flat color without a fixed image", () => {
    expect(render({ color: "white" })).toContain('fill="#FFFFFF"');
    expect(render({ color: "brown" })).toContain('fill="#885E36"');
    expect(render({})).not.toContain('<img');
  });
});

describe("BotAvatar's two avatar outcomes", () => {
  it("renders a flat cropped image for circle/rounded/square, with no mascot at all", () => {
    const markup = renderBot({ avatarUrl: "/api/attachments/cat.webp", avatarCrop: "circle" });
    expect(markup).toContain("<img");
    expect(markup).not.toContain("<svg");
  });

  it("shows the image as it is, with no mascot face painted on it", () => {
    const markup = renderBot({ avatarUrl: "/api/attachments/cat.webp", avatarCrop: "square" });
    expect(markup).toContain("<img");
    expect(markup).not.toContain("<image");
    expect(markup).not.toContain("radialGradient");
  });

  it("renders the gradient mascot when the crop is mascot, image or not", () => {
    const markup = renderBot({ avatarUrl: "/api/attachments/cat.webp", avatarCrop: "mascot" });
    expect(markup).not.toContain("<img");
    expect(markup).toContain("<svg");
  });

  it("falls back to the gradient mascot when a flat crop has no valid image", () => {
    const markup = renderBot({ avatarUrl: undefined, avatarCrop: "circle" });
    expect(markup).not.toContain("<img");
    expect(markup).toContain("<svg");
  });
});

describe("resolveBotAvatarOutcome", () => {
  // `imageFailed` is set by the flat <img>'s own onError, which
  // renderToStaticMarkup never fires — there are no events in a static
  // render. The decision is a pure function precisely so this branch is
  // still testable synchronously.
  it("falls back to the gradient mascot for an image that failed to load", () => {
    expect(
      resolveBotAvatarOutcome({ avatarCrop: "circle", hasUrl: true, imageFailed: true }),
    ).toBe("gradientMascot");
  });

  it("renders a good flat image flat", () => {
    expect(
      resolveBotAvatarOutcome({ avatarCrop: "rounded", hasUrl: true, imageFailed: false }),
    ).toBe("flatImage");
  });

  it("keeps the mascot crop on the gradient mascot even with a loaded image", () => {
    expect(
      resolveBotAvatarOutcome({ avatarCrop: "mascot", hasUrl: true, imageFailed: false }),
    ).toBe("gradientMascot");
  });

  it("falls back to the gradient mascot when there is no image at all", () => {
    expect(
      resolveBotAvatarOutcome({ avatarCrop: "square", hasUrl: false, imageFailed: false }),
    ).toBe("gradientMascot");
  });
});
