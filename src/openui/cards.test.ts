import { createParser } from "@openuidev/lang-core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CARD_GUIDE, CARD_GUIDE_EXAMPLE, CARD_NAMES } from "../../shared/card-guide";
import { CARD_EXAMPLES } from "./card-examples";
import { amountOf, cardMessage, money, receiptTotals } from "./components/cards";
import { library } from "./library";
import { v3Library } from "./library-v3";
import { SMART_UI_EXAMPLE } from "./prompt";
import { drawable, SmartUi } from "./SmartUi";

const BASE = [
  "Col", "Row", "Grid", "Card", "Divider", "Spacer",
  "Title", "Text", "Caption", "Badge", "Link", "List", "ListItem", "Callout",
  "Stat", "Table", "Chart",
  "Button", "Input", "Select", "SegmentedControl", "Checkbox", "DatePicker", "Form",
];
const v3Parser = createParser(v3Library.toJSONSchema(), "Col");
const baseParser = createParser(library.toJSONSchema(), "Col");

/** Every component name drawn anywhere in a parsed tree. */
function typeNames(node: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(node)) for (const child of node) typeNames(child, out);
  else if (node && typeof node === "object") {
    const el = node as { type?: unknown; typeName?: unknown; props?: unknown };
    if (el.type === "element" && typeof el.typeName === "string") out.add(el.typeName);
    for (const value of Object.values(el.props && typeof el.props === "object" ? el.props : {})) typeNames(value, out);
  }
  return out;
}

/** "a, b?: {x, y}[], c?" → ["a", "b", "c"], splitting only top-level commas. */
function paramNames(args: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of args) {
    if ("{[(".includes(ch)) depth++;
    if ("}])".includes(ch)) depth--;
    if (ch === "," && depth === 0) { parts.push(cur); cur = ""; } else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => /^\s*([A-Za-z]+)/.exec(p)?.[1] ?? "");
}

const draw = (code: string, cards: boolean) =>
  renderToStaticMarkup(createElement(SmartUi, { code, streaming: false, theme: "dark", cards, fallback: createElement("p", null, "FALLBACK") }));

describe("v3 card library", () => {
  it("has exactly the cards in CARD_NAMES on top of the base library", () => {
    const names = Object.keys(v3Library.components);
    for (const name of CARD_NAMES) expect(names).toContain(name);
    expect(names.filter((n) => !BASE.includes(n)).sort()).toEqual([...CARD_NAMES].sort());
    for (const name of BASE) expect(names).toContain(name);
  });

  it("leaves the base library exactly as it was", () => {
    expect(Object.keys(library.components).sort()).toEqual([...BASE].sort());
    for (const name of CARD_NAMES) expect(library.components).not.toHaveProperty(name);
  });

  it("lists every card's props in the guide in schema order", () => {
    for (const name of CARD_NAMES) {
      const line = new RegExp(`^${name}\\((.*)\\)$`, "m").exec(CARD_GUIDE);
      expect(line, `${name} signature in CARD_GUIDE`).not.toBeNull();
      const schema = Object.keys((v3Library.components[name]!.props as unknown as { shape: Record<string, unknown> }).shape);
      expect(paramNames(line![1]!), name).toEqual(schema);
    }
  });
});

describe("card examples", () => {
  const blocks = [{ name: "Person" as const, title: "guide example", code: CARD_GUIDE_EXAMPLE }, ...CARD_EXAMPLES];

  it("cover every card", () => {
    for (const name of CARD_NAMES) expect(CARD_EXAMPLES.some((e) => e.name === name), name).toBe(true);
  });

  it.each(blocks.map((b) => [`${b.name}: ${b.title}`, b] as const))("%s parses with the v3 parser only", (_, block) => {
    const result = v3Parser.parse(block.code);
    expect(result.meta.errors).toEqual([]);
    expect(result.meta.unresolved ?? []).toEqual([]);
    expect(result.root?.typeName).toBe("Col");
    expect(typeNames(result.root).has(block.name)).toBe(true);
    expect(drawable(block.code, true)).toBe(true);

    const base = baseParser.parse(block.code);
    const drawn = typeNames(base.root);
    for (const name of CARD_NAMES) expect(drawn.has(name)).toBe(false);
  });

  it.each(blocks.map((b) => [`${b.name}: ${b.title}`, b] as const))("%s draws as a card only with cards on", (_, block) => {
    const html = draw(block.code, true);
    expect(html).toContain("iui-v3-card");
    expect(html).not.toContain("FALLBACK");
    expect(draw(block.code, false)).not.toContain("iui-v3-card");
  });
});

describe("cards drawn", () => {
  it("keeps the base examples drawing the same with cards on or off", () => {
    expect(draw(SMART_UI_EXAMPLE, true)).toBe(draw(SMART_UI_EXAMPLE, false));
  });

  it("a receipt adds the lines, the tax and the total", () => {
    const html = draw(CARD_EXAMPLES.find((e) => e.title === "Workshop invoice with SST")!.code, true);
    // 180 + 45 + 2 × 60 = 345; 8% tax = 27.60; total 372.60
    expect(html).toContain("RM 345.00");
    expect(html).toContain("RM 27.60");
    expect(html).toContain("RM 372.60");
    expect(html).toContain("2 × RM 60.00");
  });

  it("schedule shows the button when off, a badge when on", () => {
    const off = draw(CARD_EXAMPLES.find((e) => e.title === "A weekly report, proposed")!.code, true);
    expect(off).toContain("turn it on");
    const on = draw(CARD_EXAMPLES.find((e) => e.title === "A reminder that is already on")!.code, true);
    expect(on).not.toContain("turn it on");
    expect(on).toMatch(/iui-badge-success">on</);
  });

  it("handles missing optional props and odd values without falling back", () => {
    const code = `root = Col([a, b, c, d, e, f, g, h, i, j])
a = Person("Siti")
b = Approval("Book the hall?")
c = Choices("Which one?", [])
d = Steps("Nothing yet", [])
e = Receipt("Quote", [{label: "deposit", amount: "RM 1,200.50"}])
f = Schedule("Daily digest", "")
g = SettingChange("Language", "malay", "english")
h = FilePreview("notes.md")
i = Compare([])
j = Draft("Hafiz", "see you at 3")`;
    expect(v3Parser.parse(code).meta.errors).toEqual([]);
    const html = draw(code, true);
    expect(html).not.toContain("FALLBACK");
    expect(html.match(/class="iui-v3-card /g)).toHaveLength(10);
    expect(html).toContain("RM 1,200.50");
  });

  it("does not animate a block drawn after it settled", () => {
    expect(draw(CARD_GUIDE_EXAMPLE, true)).not.toContain("iui-v3-rise");
  });
});

describe("card messages and sums", () => {
  it("defaults name what is being approved, changed or sent", () => {
    expect(cardMessage.approve("Reply to Aina?")).toBe("yes, go ahead: Reply to Aina?");
    expect(cardMessage.approve("x", "yes, send it")).toBe("yes, send it");
    expect(cardMessage.reject("Reply to Aina?")).toBe("no, don't: Reply to Aina?");
    expect(cardMessage.choices(["a", "b"])).toBe("a, b");
    expect(cardMessage.schedule("Monday summary", "every monday, 9am")).toBe("turn on: Monday summary (every monday, 9am)");
    expect(cardMessage.setting("reply hours", "9am to 6pm", "8am to 10pm")).toBe("change reply hours from 9am to 6pm to 8am to 10pm");
    expect(cardMessage.open("october-sales.xlsx")).toBe("open october-sales.xlsx");
    expect(cardMessage.send("whatsapp", "Aina")).toBe("send this whatsapp to Aina");
    expect(cardMessage.send("email", "x", "send the reminder")).toBe("send the reminder");
    expect(cardMessage.sendEdited("whatsapp", "Aina", " jumaat petang 2pm boleh? \n")).toBe("send this whatsapp to Aina, exactly as i edited it:\n\njumaat petang 2pm boleh?");
  });

  it("reads amounts and rounds sums to the sen", () => {
    expect(amountOf("RM 1,200.50")).toBe(1200.5);
    expect(amountOf(45)).toBe(45);
    expect(amountOf("free")).toBeNull();
    expect(receiptTotals([{ amount: 0.1 }, { amount: 0.2, qty: 3 }], 6)).toEqual({ lines: [0.1, 0.6], subtotal: 0.7, rate: 6, tax: 0.04, total: 0.74 });
    expect(receiptTotals([{ amount: 100 }])).toMatchObject({ subtotal: 100, tax: 0, total: 100 });
    expect(money(1234.5, "RM")).toBe("RM 1,234.50");
  });
});
