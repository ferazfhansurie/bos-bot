import { describe, expect, it, vi } from "vitest";
vi.mock("@/components/RoutinesPage", () => ({ RoutineEditor: () => null }));
import { conversationResources } from "./ConversationActions";
import type { Message } from "@/state/store";
const reply = (id: string, text: string, extra: Partial<Message> = {}): Message => ({ id, role: "bot", kind: "text", text, at: 1, ...extra });
describe("conversation header resources", () => {
  it("deduplicates delivered files and keeps their authorizing message", () => {
    const first = reply("one", '<attached-file path="/tmp/report.pdf" name="report.pdf" />');
    const last = reply("two", "[final report](/tmp/report.pdf)", { attachments: [{ kind: "image", path: "/tmp/chart.png", mime: "image/png" }] });
    const resources = conversationResources([first, last]);
    expect(resources.outputs.map(file => [file.path, file.name, file.message.id])).toEqual([
      ["/tmp/report.pdf", "final report", "two"], ["/tmp/chart.png", "chart.png", "two"],
    ]);
  });
  it("collects only assistant web citations, not user uploads or dangerous schemes", () => {
    const resources = conversationResources([
      reply("user", "[upload](/tmp/private.pdf)", { role: "user" }),
      reply("answer", "[source](https://example.com/doc) [again](https://example.com/doc) [bad](javascript:alert)"),
    ]);
    expect(resources.outputs).toEqual([]);
    expect(resources.sources).toEqual([{ url: "https://example.com/doc", name: "again" }]);
  });
});
