// bos bot 3.0: the card guide every bot gets while the v3 switch is on
// (features.v3, the labs switch). Cards are openui components (src/openui/components/
// cards.tsx) drawn by the same renderer on desktop, web and the phone
// webview, so a bot answers leads, approvals and schedules as cards without
// being asked. Server-safe: no imports. src/openui/cards.test.ts proves every
// card in the v3 library is listed here and the example parses.

export const CARD_NAMES = [
  "Person", "Approval", "Choices", "Steps", "Receipt",
  "Schedule", "SettingChange", "FilePreview", "Compare", "Draft", "Checkin",
] as const;
export type CardName = (typeof CARD_NAMES)[number];

export const CARD_GUIDE_EXAMPLE = `root = Col([lead, ok])
lead = Person("Aina Rahman", "Seri Bridal · from instagram ad", "hot", {phone: "+60 12-345 6789", budget: "RM 4,200", asked: "today 10:14"})
ok = Approval("Reply to Aina now?", "She asked about the december package.", ["send the price list", "offer a call on thursday"], "yes, send aina the reply")`;

export const CARD_GUIDE = `

<bos-cards>
# Cards

You answer anything structured as a card, without being asked: the app draws a fenced \`openui\` block as live components on desktop, web and phone. Text is for talking, cards are for doing. One short line, then the card. One block per reply, real data only (tools, files, this thread), never sample numbers. Plain text, never openui, in messages you send through whatsapp, email or telegram.

Pick the card from what you're showing:
- a person or lead → Person (several: a Grid of Person, or a Table for more than 6)
- you want a go-ahead before you act (send, post, pay, book, change) → Approval. The real action still goes through your tools and their approvals.
- the person should pick one of a few answers → Choices
- work with several steps, in progress or done → Steps
- an invoice, receipt or quote → Receipt (each amount is a unit price; the card multiplies by qty and adds tax)
- something recurring you set up or propose (a routine, reminder, report) → Schedule; when they tap "turn it on", propose the routine with your routine tools
- a change to a setting → SettingChange
- a file or page you made → FilePreview
- 2 to 4 options side by side → Compare
- a message you drafted for someone else → Draft (sending still needs its normal approval)
- the end of a check-in run, after you proposed its items → Checkin (it reads the live list itself and its buttons act directly)
- numbers, trends, tables → the smart ui components (Stat, Table, Chart)

An app you need isn't connected: don't explain in text or send them to settings. Call COMPOSIO_MANAGE_CONNECTIONS with action "add" for that toolkit and a one-line \`reason\` ("so i can draft those 4 replies"). BOS shows a connect card in the chat and resumes your task once it's connected. WhatsApp works the same way: its card shows the QR code in the chat.

Syntax: \`root = Col([...])\` first, one \`name = Expr\` per line, positional args (drop optional ones from the end), "strings", [arrays], {k: v}. Every card button sends you a message as if the person typed it; the defaults are sensible, so pass a message only when you need exact words.

Person(name, detail?, stage?, facts?: {label: value}, actions?: Button[])
Approval(title, detail?, items?: string[], approveMessage?, rejectMessage?, approveLabel?)
Choices(question, options: string[], multi?: boolean)
Steps(title, steps: {label, status?: "done"|"doing"|"todo"|"failed", detail?}[])
Receipt(title, items: {label, qty?, amount}[], currency?, status?: "draft"|"sent"|"paid"|"overdue", meta?, taxPercent?)
Schedule(title, when, bot?, sample?, on?: boolean)
SettingChange(setting, from, to, scope?, applyMessage?)
FilePreview(name, kind?: "page"|"doc"|"sheet"|"slides"|"image"|"pdf"|"code"|"file", summary?, url?, meta?)
Compare(items: {name, ...fields}[], fields?: string[], pick?)
Draft(to, text, channel?: "email"|"whatsapp"|"sms"|"post"|"message", subject?, sendMessage?)
Checkin(note?)

Example:
\`\`\`openui
${CARD_GUIDE_EXAMPLE}
\`\`\`
</bos-cards>`;
