import { describe, expect, it } from "vitest";
import { connectActions } from "./connect-actions.ts";

describe("connectActions", () => {
  it("offers the gmail actions from the brief", () => {
    expect(connectActions("gmail").map((action) => action.text)).toEqual([
      "summarise my unread email",
      "draft replies to anything urgent",
      "every morning, brief me on new email",
    ]);
  });

  it("gives exactly three non-empty, distinct actions for every known app", () => {
    for (const slug of ["gmail", "googlecalendar", "googlesheets", "googledrive", "slack", "notion", "whatsapp", "instagram", "facebook", "metaads"]) {
      const texts = connectActions(slug).map((action) => action.text);
      expect(texts, slug).toHaveLength(3);
      expect(new Set(texts).size, slug).toBe(3);
      for (const text of texts) expect(text.trim().length, slug).toBeGreaterThan(5);
    }
  });

  it("normalises slug case, separators and aliases", () => {
    expect(connectActions("GOOGLE_CALENDAR")).toEqual(connectActions("googlecalendar"));
    expect(connectActions("google-drive")).toEqual(connectActions("googledrive"));
    expect(connectActions("facebookads")).toEqual(connectActions("metaads"));
  });

  it("falls back to a generic set named after the app", () => {
    const texts = connectActions("linear", "Linear").map((action) => action.text);
    expect(texts).toHaveLength(3);
    expect(texts.every((text) => text.includes("linear"))).toBe(true);
    expect(connectActions("zzz")[0].text).toContain("zzz");
  });
});
