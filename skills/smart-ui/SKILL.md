---
name: smart-ui
description: "Draw live ui in a reply (tables, charts, stat tiles, buttons, forms) with a fenced openui block. Use for data answers: numbers, comparisons, breakdowns, trends, lists to act on."
---

# Smart UI

Replies are markdown, and a fenced block tagged `openui` (OpenUI Lang) draws live components in this chat on web, desktop and phone as you stream.

Use it for numbers, comparisons, breakdowns, trends and lists to act on. Skip it for chat, single facts, plans and prose. One block per reply at most, after a one-line lead-in, under ~60 lines. Show only data you have (tools, files, this thread); never invent numbers.

Syntax: one `name = Expr` per line, first `root = Col([...])`; every other name must be used. Args are positional (drop optional ones from the end, no `key: value`). "strings", `[arrays]`, `{k: v}`. `$range = "30d"` is state that inputs bind to. Operators + - * / == != > < && || ! and `a ? b : c`; `rows.amount` plucks a field from every row; `@Each(rows, "r", [r.name, Badge(r.stage)])` maps rows.

Button("Draft follow-ups", @ToAssistant("draft follow-ups for the 3 stale leads")) sends you that message (no action: its label). Real changes still go through your tools and approvals; @Set only changes the screen.

Never put openui in messages sent through a tool (whatsapp, email, telegram); plain text there.

Components (positional args, ? = optional):
Col(children: Node[], gap?: number, align?: "start" | "center" | "end" | "stretch")
Row(children: Node[], gap?: number, align?: "start" | "center" | "end" | "stretch", justify?: "start" | "center" | "end" | "between", wrap?: boolean)
Grid(children: Node[], columns?: number, minChildWidth?: number, gap?: number) — Equal columns (default 2). With minChildWidth (px), columns drop on narrow screens.
Card(children: Node[], variant?: "outline" | "soft", padding?: number, gap?: number)
Divider()
Spacer()
Title(text: string, size?: "sm" | "md" | "lg" | "xl" | "2xl" | "3xl", color?: Color) — Heading; md for a card title, lg for a section, 2xl for a big number.
Text(text: string | Node[], size?: "xs" | "sm" | "md" | "lg", color?: Color, weight?: "normal" | "medium" | "semibold") — **bold**, *italic*, `code`, [links](https://…); text may mix strings and components: ["Stage ", Badge("won", "success")].
Caption(text: string, color?: Color)
Badge(text: string, color?: "neutral" | "info" | "success" | "warning" | "danger" | "purple" | "pink") — Pill tag, e.g. a status.
Link(text: string, url: string)
List(items: (string | ListItem)[], marker?: "bullet" | "number" | "none", timeline?: boolean) — timeline joins the markers with a line.
ListItem(title: string, description?: string, marker?: string, children?: Node[])
Callout(text: string, tone?: "info" | "success" | "warning" | "danger", title?: string) — Highlighted note: a takeaway, a warning or a next step.
Stat(label: string, value: string | number, change?: number, hint?: string) — KPI tile. change is a percent (12 shows ▲ 12%); put several in a Grid.
Table(columns: string[], rows: any[][]) — Each row lists its cells in column order; a cell may be a component. Number columns align right.
Chart(type: "bar" | "line" | "area" | "pie" | "donut" | "scatter", data: Record<string, string | number>[], x?: string, series?: string[], format?: "number" | "currency" | "percent", currency?: string, stacked?: boolean, height?: number) — x is the category key, series the number keys (default: all). percent values are like 45.
Button(label: string, action?: ActionExpression, variant?: "solid" | "outline" | "soft" | "ghost", color?: "primary" | "danger" | "success", size?: "sm" | "md" | "lg", disabled?: boolean)
Input(value: $binding<string | number>, label?: string, type?: "text" | "number", placeholder?: string)
Select(value: $binding<string>, options: (string | {value: string, label: string})[], label?: string, placeholder?: string)
SegmentedControl(value: $binding<string>, options: (string | {value: string, label: string})[], block?: boolean) — 2 to 4 short choices in a row.
Checkbox(checked: $binding<boolean>, label: string, lineThrough?: boolean) — lineThrough strikes the label when checked, for to-do lists.
DatePicker(value: $binding<string>, label?: string, min?: string, max?: string)
Form(children: Node[]) — Groups fields; their values go with any @ToAssistant inside.

Functions (compute from the data so numbers agree):
@Count(array: any[]) → number
@Sum(numbers: number[]) → number
@Avg(numbers: number[]) → number
@Min(numbers: number[]) → number
@Max(numbers: number[]) → number
@Sort(array: any[], field: string, direction?: "asc" | "desc") → any[]
@Filter(array: any[], field: string, operator: "==" | "!=" | ">" | "<" | ">=" | "<=" | "contains", value: any) → any[] — Filter array by field value
@Round(number: number, decimals?: number) → number
@Each(array: any[], varName: string, template: any) — Maps rows; write the template inline and use varName only inside it.
@Percent(part: number, total: number) → number
@Format(value: number, kind?: "number" | "currency" | "percent" | "compact", decimals?: number, currency?: string) → string — "compact" gives 1.2M; currency is a code like "MYR".
@Today() → string
@FormatDate(date: string | number, style?: "date" | "short" | "long" | "weekday" | "month" | "time" | "datetime" | "iso") → string — Dates are "YYYY-MM-DD", ISO or a timestamp.
@GroupBy(rows: any[], key: string, field?: string, agg?: "sum" | "avg" | "count" | "min" | "max") → {key: string | number, value: number}[] — One row per key; value is agg of field (default sum), or the row count without field.
@Top(rows: any[], field: string, n: number, direction?: "desc" | "asc") → any[]
@Bucket(rows: any[], dateField: string, unit: "day" | "week" | "month", field?: string, agg?: "sum" | "avg" | "count" | "min" | "max") → {key: string | number, value: number}[] — Rows per day/week/month in date order; key is "YYYY-MM-DD" or "YYYY-MM".
@Change(current: number, previous: number) → number — Percent change, e.g. @Change(120, 100) is 20.

Action steps:
@ToAssistant(message: string) — Sends you message as if the person typed it, with any Form values
@OpenUrl(url: string)
@Set(variable: $variable, value: any)

Example:
```openui
root = Col([kpis, chart, table, actions])
kpis = Grid([Stat("Leads", @Count(leads), 12, "vs last week"), Stat("Won", @Count(@Filter(leads, "stage", "==", "won"))), Stat("Pipeline", @Format(@Sum(leads.value), "compact", 0, "MYR"))], 3)
chart = Chart("bar", @GroupBy(leads, "source", "value"), "key", ["value"], "currency", "MYR")
table = Table(["Name", "Source", "Value", "Stage"], @Each(@Top(leads, "value", 5), "l", [l.name, l.source, l.value, Badge(l.stage, l.stage == "won" ? "success" : "neutral")]))
actions = Row([Button("Chase the open ones", @ToAssistant("draft follow-ups for every open lead above")), Button("Export csv", @ToAssistant("export these leads as a csv"), "outline")])
leads = [{name: "Aina", source: "ads", value: 4200, stage: "won"}, {name: "Hafiz", source: "referral", value: 3100, stage: "open"}]
```
