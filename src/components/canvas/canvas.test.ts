import { describe, expect, it } from "vitest";
import { CANVAS_STARTERS, canvasDocument, canvasFileTitle, htmlTitle, libraryView, type LibraryItem } from "./canvas";
import { readFileSync } from "node:fs";
import { selectBundledSkills, loadBundledSkills } from "../../../server/skill-library";

describe("blank tab", () => {
  it("is a default skill: a plain chat ask for a tab or deck brings it in", () => {
    const skills = loadBundledSkills("skills");
    const picked = (text: string, caps = ["pageTabs"]) => selectBundledSkills(text, caps, skills).map(s => s.manifest.id);
    expect(picked("start a new tab makeit my bosbot dashboard")).toContain("blank-tab");
    expect(picked("a 5-slide deck about bos bot")).toContain("blank-tab");
    expect(picked("make slide 2 a chart")).toContain("blank-tab");
    expect(picked("start a new tab makeit my bosbot dashboard", [])).not.toContain("blank-tab");
    expect(picked("what time is it")).not.toContain("blank-tab");
    for (const s of CANVAS_STARTERS.filter(s => s.id !== "video")) expect(picked(s.prompt + "x")).toContain("blank-tab");
    const skill = readFileSync("skills/blank-tab/SKILL.md", "utf8");
    expect(skill).toContain("open_tab");
    expect(skill).toContain("top-level <section>");
  });

  it("titles the tab from the page", () => {
    expect(htmlTitle("<html><head><title> bos bot \n deck</title></head></html>")).toBe("bos bot deck");
    expect(htmlTitle("<p>no title</p>")).toBeUndefined();
  });

  it("puts the sandbox csp ahead of the page's own head", () => {
    const doc = canvasDocument("<!DOCTYPE html><html><head><script>evil()</script></head><body><section>1</section></body></html>", "f1");
    expect(doc.startsWith("<!doctype html><html><head><meta charset")).toBe(true);
    expect(doc.indexOf("Content-Security-Policy")).toBeLessThan(doc.indexOf("evil()"));
    expect(doc).toContain('var ID="f1"');
    const bare = canvasDocument("<section>1</section>", "f2");
    expect(bare).toMatch(/^<!doctype html><html><head>.*<\/head><body><section>1<\/section><\/body><\/html>$/s);
  });
});

describe("library", () => {
  const items: LibraryItem[] = [
    { kind: "page", id: "bos-pages/a.html", title: "deck about bos", at: 3 },
    { kind: "doc", id: "p-1", title: "Launch plan", at: 5 },
    { kind: "video", id: "v-1", title: "Promo", at: 1 },
  ];
  it("names a page file from its slug", () => {
    expect(canvasFileTitle("2026-10-24-5-slide-deck-about-bos-bot-k3f9.html")).toBe("5 slide deck about bos bot");
    expect(canvasFileTitle("notes.html")).toBe("notes");
  });
  it("sorts newest first, filters by kind and searches titles", () => {
    expect(libraryView(items, "all", "").map(i => i.id)).toEqual(["p-1", "bos-pages/a.html", "v-1"]);
    expect(libraryView(items, "video", "").map(i => i.id)).toEqual(["v-1"]);
    expect(libraryView(items, "all", "  BOS ").map(i => i.id)).toEqual(["bos-pages/a.html"]);
    expect(libraryView(items, "doc", "promo")).toEqual([]);
  });
});
