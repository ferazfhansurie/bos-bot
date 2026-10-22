// The smart ui prompt every bot gets, generated from the library so it can't
// drift from what the renderer accepts. openui's own generator writes a whole
// system prompt (~14KB) for apps whose replies are only ui; a bos bot answers
// in markdown and reaches for ui sometimes, so this keeps only the generated
// signature lines and wraps them in a short hand-written guide.
// Regenerate skills/smart-ui/SKILL.md with: SMART_UI_WRITE=1 pnpm vitest run src/openui/prompt.test.ts
import { library } from "./library";

// Built-ins a dashboard rarely needs; each line costs bytes on every turn.
const SKIP = new Set(["First", "Last", "Abs", "Floor", "Ceil", "Reset", "ToAssistant"]);
const nameOf = (line: string) => /^(?:- )?@?([A-Za-z]+)\(/.exec(line)?.[1] ?? "";
// Signatures that explain themselves lose their description.
const BARE = new Set([
  "Col", "Row", "Card", "Spacer", "Caption", "Link", "ListItem", "Input", "Select", "DatePicker",
  "Count", "Sum", "Avg", "Min", "Max", "Sort", "Round", "Percent", "Today", "Default", "Top", "OpenUrl", "Set",
]);
// Shorter words for the generated descriptions that run long.
const SHORT: Record<string, string> = {
  Text: "**bold**, *italic*, `code`, [links](https://…); text may mix strings and components: [\"Stage \", Badge(\"won\", \"success\")].",
  Chart: "x is the category key, series the number keys (default: all). percent values are like 45.",
  Each: "Maps rows; write the template inline and use varName only inside it.",
  Format: "\"compact\" gives 1.2M; currency is a code like \"MYR\".",
  FormatDate: "Dates are \"YYYY-MM-DD\", ISO or a timestamp.",
  GroupBy: "One row per key; value is agg of field (default sum), or the row count without field.",
  Bucket: "Rows per day/week/month in date order; key is \"YYYY-MM-DD\" or \"YYYY-MM\".",
  Change: "Percent change, e.g. @Change(120, 100) is 20.",
};
function trim(line: string): string {
  const name = nameOf(line);
  const at = line.indexOf(" — ");
  if (at < 0) return line;
  if (BARE.has(name)) return line.slice(0, at);
  return name in SHORT ? `${line.slice(0, at)} — ${SHORT[name]}` : line;
}

export function smartUiReference(): string {
  const full = library.prompt({ inlineMode: true, bindings: true, builtinFunctions: true });
  const lines = full.split("\n");
  const keep = (re: RegExp) => lines.filter((l) => re.test(l) && !SKIP.has(nameOf(l))).map(trim);
  const components = keep(/^[A-Z][A-Za-z]*\(/);
  const functions = keep(/^@[A-Z][A-Za-z]*\(/);
  const steps = lines.filter((l) => /^- @[A-Z][A-Za-z]*\(/.test(l) && !SKIP.has(nameOf(l))).map((l) => trim(l.slice(2)));
  return [
    "Components (positional args, ? = optional):",
    ...components,
    "",
    "Functions (compute from the data so numbers agree):",
    ...functions,
    "",
    "Action steps:",
    '@ToAssistant(message: string) — Sends you message as if the person typed it, with any Form values',
    ...steps,
  ].join("\n");
}

const GUIDE = `# Smart UI

Replies are markdown, and a fenced block tagged \`openui\` (OpenUI Lang) draws live components in this chat on web, desktop and phone as you stream.

Use it for numbers, comparisons, breakdowns, trends and lists to act on. Skip it for chat, single facts, plans and prose. One block per reply at most, after a one-line lead-in, under ~60 lines. Show only data you have (tools, files, this thread); never invent numbers.

Syntax: one \`name = Expr\` per line, first \`root = Col([...])\`; every other name must be used. Args are positional (drop optional ones from the end, no \`key: value\`). "strings", \`[arrays]\`, \`{k: v}\`. \`$range = "30d"\` is state that inputs bind to. Operators + - * / == != > < && || ! and \`a ? b : c\`; \`rows.amount\` plucks a field from every row; \`@Each(rows, "r", [r.name, Badge(r.stage)])\` maps rows.

Button("Draft follow-ups", @ToAssistant("draft follow-ups for the 3 stale leads")) sends you that message (no action: its label). Real changes still go through your tools and approvals; @Set only changes the screen.

Never put openui in messages sent through a tool (whatsapp, email, telegram); plain text there.`;

const EXAMPLE = `Example:
\`\`\`openui
root = Col([kpis, chart, table, actions])
kpis = Grid([Stat("Leads", @Count(leads), 12, "vs last week"), Stat("Won", @Count(@Filter(leads, "stage", "==", "won"))), Stat("Pipeline", @Format(@Sum(leads.value), "compact", 0, "MYR"))], 3)
chart = Chart("bar", @GroupBy(leads, "source", "value"), "key", ["value"], "currency", "MYR")
table = Table(["Name", "Source", "Value", "Stage"], @Each(@Top(leads, "value", 5), "l", [l.name, l.source, l.value, Badge(l.stage, l.stage == "won" ? "success" : "neutral")]))
actions = Row([Button("Chase the open ones", @ToAssistant("draft follow-ups for every open lead above")), Button("Export csv", @ToAssistant("export these leads as a csv"), "outline")])
leads = [{name: "Aina", source: "ads", value: 4200, stage: "won"}, {name: "Hafiz", source: "referral", value: 3100, stage: "open"}]
\`\`\``;

const FRONTMATTER = `---
name: smart-ui
description: "Draw live ui in a reply (tables, charts, stat tiles, buttons, forms) with a fenced openui block. Use for data answers: numbers, comparisons, breakdowns, trends, lists to act on."
---`;

/** skills/smart-ui/SKILL.md: guide, generated reference, one example. */
export function smartUiSkill(): string {
  return [FRONTMATTER, GUIDE, smartUiReference(), EXAMPLE].join("\n\n") + "\n";
}

/** The example's code, so a test can prove it parses against the library. */
export const SMART_UI_EXAMPLE = EXAMPLE.split("```openui\n")[1].split("\n```")[0];
