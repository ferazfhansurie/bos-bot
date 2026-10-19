// Synthetic visual fixture using production renderers. Never mounts the live app.
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { StoreProvider, type Message } from "../../src/state/store";
import { ChatMarkdown } from "../../src/components/ChatMarkdown";
import { SpeakButton } from "../../src/components/SpeakButton";
import { SpeakerHeader, TurnActionRow, TurnCopyButton, FeedbackButtons, ShareButton } from "../../src/components/TurnActions";
import { ActivityRun } from "../../src/components/ActivityRun";
import { TurnNarrationRun } from "../../src/components/TurnNarrationRun";
import { ToolActivity } from "../../src/components/ToolActivity";
import { DigestChip } from "../../src/components/DigestChip";
import { AttachmentGallery } from "../../src/components/AttachmentGallery";
import { applySkin } from "../../src/lib/skins";
import "../../src/styles.css";

applySkin(new URLSearchParams(location.search).get("skin") === "atelier" ? "atelier" : "midnight");
const demoName = new URLSearchParams(location.search).get("video") === "webm" ? "demo.webm" : "demo.mp4";
const at = Date.UTC(2026, 9, 16, 2);
const bot = { name: "bos", color: "green" as const };
const context = { threadId: "synthetic", messageId: "showcase" };
const tools: Message[] = Array.from({ length: 23 }, (_, index) => ({ id: `step-${index}`, role: "bot", kind: "activity", at: at + index * 1000, tool: { name: index % 3 === 0 ? "Read src/components/ChatView.tsx" : index % 3 === 1 ? "Ran pnpm typecheck" : "Edited src/styles.css", ok: true } }));
const digest: Message = {
  id: "digest", role: "bot", kind: "digest", at,
  digest: { turnId: "synthetic-turn", botId: "synthetic", threadId: "synthetic", at, durationMs: 656000, tools: [{ name: "Read", count: 23, failed: 0 }], toolCalls: 23, memory: [], reply: "Synthetic preview", hookCoverage: "none", files: { checkpoint: { cwd: "/fixture", before: "synthetic-before", after: "synthetic-after" }, changed: ["src/components/ChatView.tsx", "src/components/GroupView.tsx", "src/styles.css", "src/components/TurnActions.tsx"], added: [], deleted: [], lines: { "src/components/ChatView.tsx": [118, 23], "src/components/GroupView.tsx": [52, 91], "src/styles.css": [192, 1] } } },
};
const markdown = `The transcript now gives the answer the full column. The user message stays on the right, and the work remains available below.

## What changed

- One column with **clear speaker identity** and _quiet controls_.
- Inline code such as \`turnTerminal\` keeps its own rhythm.
- A source citation [example.com](https://example.com/research) and a [regular reference](https://example.com/reference).

| renderer | content width | user bubble |
| --- | ---: | ---: |
| desktop | 768 px | 70% |
| room | 768 px | 70% |

\`\`\`typescript
const finished = steps.filter(step => step.ok);
export const result = { finished, verified: true };
\`\`\`

For the layout calculation, \\(w = \\min(768, W - 32)\\). A display equation:

$$
\\int_0^1 x^2\\,dx = \\frac{1}{3}
$$

> The fixture is synthetic. It verifies presentation, not a deployment or a completed customer workflow.
`;
function Showcase() {
  const [feedback, setFeedback] = useState("");
  return <main className="chat-thread min-h-screen bg-app text-ink"><div className="mx-auto flex max-w-[800px] flex-col gap-6 px-4 py-8">
    <aside className="text-xs chat-text-tertiary">synthetic renderer fixture · production components · no live data</aside>
    <section className="group flex flex-col items-end gap-2"><AttachmentGallery variant="user" images={["/api/attachments/fixture-one.png"]} message={context} eager /><div className="chat-user-bubble">can you match this transcript layout and show the evidence?</div><TurnActionRow persistent={false} align="end" at={at}><TurnCopyButton text="can you match this transcript layout and show the evidence?" /></TurnActionRow></section>
    <section className="group flex min-w-0 flex-col gap-3"><SpeakerHeader bot={bot} name={bot.name} />
      <TurnNarrationRun label="Worked for 10m 56s"><ChatMarkdown text="i’ll check the transcript structure, then compare the settled and streaming states." /><ActivityRun messages={tools} forceOpen>{tools.map(message => <ToolActivity key={message.id} tool={message.tool!} />)}</ActivityRun></TurnNarrationRun>
      <ChatMarkdown text={markdown} /><DigestChip message={digest} />
      <TurnActionRow persistent at={at}><TurnCopyButton text={markdown} /><SpeakButton text={markdown} botId="synthetic" messageId="showcase" iconSize={18} className="chat-ghost p-1 opacity-100" /><FeedbackButtons active={{ good: feedback === "👍", bad: feedback === "👎" }} onReact={emoji => setFeedback(value => value === emoji ? "" : emoji)} /><ShareButton text={markdown} /></TurnActionRow>
    </section>
    <section className="flex min-w-0 flex-col gap-3"><SpeakerHeader bot={bot} name="bos" /><p>single image · existing repository screenshot</p><AttachmentGallery images={["/api/attachments/fixture-two.png"]} message={context} eager /><p>gallery · five distinct references to existing fixture pixels</p><AttachmentGallery images={[1, 2, 3, 4, 5].map(i => `/api/attachments/gallery-${i}.png`)} message={context} eager /></section>
    <section className="flex min-w-0 flex-col gap-3"><SpeakerHeader bot={bot} name="bos" /><p>video uses an existing recording. audio and document files are synthetic. unavailable assets exercise separate honest error states.</p><AttachmentGallery message={context} files={[{ path: `/fixture/${demoName}`, name: demoName, private: true }, { path: "/fixture/audio.wav", name: "audio.wav", private: true }, { path: "/fixture/report.pdf", name: "report.pdf", private: true }, { path: "/fixture/brief.docx", name: "brief.docx", private: true }, { path: "/fixture/preview.html", name: "preview.html", private: true }]} /></section>
    <section className="flex min-w-0 flex-col gap-3"><SpeakerHeader bot={bot} name="bos" /><p>image loading and deleted states · click thumbnails to inspect the lightbox</p><AttachmentGallery images={["/api/attachments/fixture-loading.png", "/api/attachments/fixture-deleted.png"]} message={context} eager /><ChatMarkdown text={'```html\n<!doctype html><html><body><h1>Synthetic artifact</h1><p>Isolated HTML preview.</p></body></html>\n```'} /><ToolActivity tool={{ name: "Read missing-file.ts", ok: false, output: "Synthetic fixture: file unavailable" }} /><ToolActivity tool={{ name: "Searching files" }} /><ChatMarkdown text="a streaming response keeps the same full-width prose and speaker header." streaming /></section>
  </div></main>;
}
createRoot(document.getElementById("root")!).render(<StoreProvider><Showcase /></StoreProvider>);
