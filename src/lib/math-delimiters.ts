// Models write LaTeX as \( … \) and \[ … \] at least as often as with dollar
// signs, while remark-math only reads dollars. Rewrite the backslash forms to
// $$ … $$ outside code, so both reach the math renderer. Single dollars stay
// text (remark-math runs with singleDollarTextMath off) because "$5 and $10"
// in a price list is far more common than inline maths.
const CODE = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/g;
const DISPLAY = /(^|\n)([ \t]*)\\\[([\s\S]+?)\\\]/g;
const INLINE = /\\\(([^\n]+?)\\\)/g;

export function normalizeMathDelimiters(text: string): string {
  if (!text.includes("\\(") && !text.includes("\\[")) return text;
  return text.split(CODE).map((part, index) => index % 2 === 1 ? part : part
    .replace(DISPLAY, (_match, lead: string, indent: string, body: string) => `${lead}${indent}$$\n${body.trim()}\n${indent}$$`)
    .replace(INLINE, (_match, body: string) => `$$${body.trim()}$$`)).join("");
}
