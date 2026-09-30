import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StoreProvider } from "@/state/store";
import { ProfileFields } from "./SettingsModal";

describe("desktop profile", () => {
  it("offers an image picker and a photo preview", () => {
    const markup = renderToStaticMarkup(createElement(StoreProvider, null, createElement(ProfileFields)));
    expect(markup).toContain("Choose photo");
    expect(markup).toContain('type="file"');
    expect(markup).toContain('accept="image/png,image/jpeg,image/gif,image/webp"');
    expect(markup).toContain('aria-label="Profile photo"');
  });
});
