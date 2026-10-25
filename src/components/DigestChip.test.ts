import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Message } from "@/state/store";
import { CompactionChip, DigestChip } from "./DigestChip";

const message: Message = {
  id: "receipt", role: "bot", kind: "digest", at: 1, text: "Observed work, not a completion verdict",
  digest: {
    turnId: "turn", botId: "bot", threadId: "thread", at: 1, durationMs: 100,
    tools: [{ name: "Bash", count: 12, failed: 1 }], toolsDropped: 2, toolCalls: 19,
    files: { changed: ["a.ts"], added: [], deleted: [], truncated: 4 },
    memory: [], reply: "Finished this turn.", hookCoverage: "preview",
  },
};

describe("DigestChip", () => {
  it("shows compaction as expandable historical text, never executable markup", () => {
    const html = renderToStaticMarkup(createElement(CompactionChip, { message: {
      id: "context", role: "bot", kind: "compaction", at: 1,
      compaction: { summary: "Latest correction: <script>bad()</script> x < -5", firstKeptId: "", foldedThroughId: "old", tokensBefore: 1, by: "person" },
    } }));
    expect(html).toContain("<details");
    expect(html).toContain("Earlier context summarized");
    expect(html).toContain("Your full conversation is still here");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });
  it("shows total counts rather than only the truncated sample", () => {
    const html = renderToStaticMarkup(createElement(DigestChip, { message }));
    expect(html).toContain("Edited ");
    expect(html).toContain("5 files");
    expect(html).toContain("View changes");
    expect(html).toContain('title="Observed work, not a completion verdict"');
  });

  it("does not imply zero changed files when capture was unavailable", () => {
    const html = renderToStaticMarkup(createElement(DigestChip, { message: { ...message, digest: { ...message.digest!, files: undefined, toolCalls: undefined } } }));
    expect(html).toContain("Did 12+ tool calls");
    expect(html).not.toContain("files changed");
  });
  it("says one tool call, not one tool calls", () => {
    const html = renderToStaticMarkup(createElement(DigestChip, { message: { ...message, digest: { ...message.digest!, tools: [{ name: "Bash", count: 1, failed: 0 }], toolsDropped: 0, toolCalls: 1, files: undefined } } }));
    expect(html).toContain("Did 1 tool call");
    expect(html).not.toContain("1 tool calls");
  });
});
