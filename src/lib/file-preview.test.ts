import { describe, expect, it } from "vitest";

import { languageFor, linkedFilePath, looksLikeText, mimeFor, parseDelimited, previewKind } from "./file-preview";

describe("previewKind", () => {
  it("picks a viewer from the name", () => {
    expect(previewKind("/a/b/shot.PNG")).toBe("image");
    expect(previewKind("demo.mov")).toBe("video");
    expect(previewKind("voice.m4a")).toBe("audio");
    expect(previewKind("report.pdf")).toBe("pdf");
    expect(previewKind("/Users/x/my report.html")).toBe("html");
    expect(previewKind("notes.md")).toBe("markdown");
    expect(previewKind("leads.csv")).toBe("table");
    expect(previewKind("src/app.tsx")).toBe("text");
    expect(previewKind("server.log")).toBe("text");
    expect(previewKind("Dockerfile")).toBe("text");
    expect(previewKind("book.xlsx")).toBe("other");
  });

  it("falls back to the served type when the name says nothing", () => {
    expect(previewKind("download", "image/jpeg")).toBe("image");
    expect(previewKind("download", "text/plain; charset=utf-8")).toBe("text");
    expect(previewKind("download", "application/octet-stream")).toBe("other");
  });
});

describe("parseDelimited", () => {
  it("keeps quoted commas, quotes and newlines in one field", () => {
    const { rows } = parseDelimited('﻿name,note\r\n"Ali, Bin","said ""hi""\nthen left"\nSiti,ok\n');
    expect(rows).toEqual([["name", "note"], ["Ali, Bin", 'said "hi"\nthen left'], ["Siti", "ok"]]);
  });

  it("reads tab separated rows and stops at the row cap", () => {
    expect(parseDelimited("a\tb\nc\td", "\t").rows).toEqual([["a", "b"], ["c", "d"]]);
    expect(parseDelimited("1\n2\n3\n4", ",", 2)).toEqual({ rows: [["1"], ["2"]], truncated: true });
  });
});

describe("helpers", () => {
  it("types blobs the browser has to render", () => {
    expect(mimeFor("a.pdf")).toBe("application/pdf");
    expect(mimeFor("a.mp4")).toBe("video/mp4");
    expect(mimeFor("a.txt")).toBe("");
  });

  it("tells text from binary and code from prose", () => {
    expect(looksLikeText(new TextEncoder().encode("hello"))).toBe(true);
    expect(looksLikeText(new Uint8Array([80, 75, 3, 4, 0, 0]))).toBe(false);
    expect(languageFor("x/main.py")).toBe("python");
    expect(languageFor("readme.txt")).toBe("text");
  });
});

describe("linkedFilePath", () => {
  it("decodes a link target once, the way the server does", () => {
    expect(linkedFilePath("/Users/firaz/launch%20kit/logo%201.png")).toBe("/Users/firaz/launch kit/logo 1.png");
    expect(linkedFilePath("/Users/firaz/report.md?download=1#top")).toBe("/Users/firaz/report.md");
    expect(linkedFilePath("/Users/firaz/a%2520b.md")).toBe("/Users/firaz/a%20b.md");
    expect(linkedFilePath("/Users/firaz/100%.md")).toBe("/Users/firaz/100%.md");
  });
});
