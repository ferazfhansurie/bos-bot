// Plain titles for the 3.0 skill cards: a skill's kebab-case name read as a
// short sentence a person would say ("file-expense" → "File an expense"),
// and the first sentence of its description as the line under it.

const VERBS = new Set([
  "add", "analyse", "analyze", "answer", "audit", "book", "build", "check", "clean", "close", "create", "debug",
  "deploy", "design", "draft", "edit", "export", "file", "find", "fix", "generate", "import", "invoice", "log",
  "make", "merge", "onboard", "open", "order", "pay", "plan", "post", "prepare", "publish", "quote", "read",
  "record", "refactor", "reply", "review", "run", "scan", "schedule", "send", "ship", "start", "submit",
  "summarise", "summarize", "sync", "test", "track", "translate", "triage", "update", "write",
]);

/** Words that already fill the article's slot, or make one wrong. */
const NO_ARTICLE_AFTER_VERB = new Set([
  "a", "an", "the", "my", "your", "our", "their", "his", "her", "its", "all", "every", "each", "any", "some",
  "to", "for", "with", "from", "on", "in", "into", "up", "out", "down", "off", "over", "back", "away", "by", "via",
  "me", "you", "us", "them", "it", "this", "that", "these", "those",
]);

/** Nouns that read wrong with "a": "check an email" → "check email". */
const UNCOUNTABLE = new Set([
  "email", "mail", "inbox", "code", "data", "feedback", "news", "research", "content", "copy", "money", "info",
  "information", "software", "work", "traffic", "advice", "help", "stock", "inventory", "payroll", "leave", "time",
  "seo", "analytics", "metadata", "docs", "notes", "status", "progress", "everything", "stuff", "media", "spam",
  "cash", "revenue", "billing", "pricing", "marketing", "outreach", "support",
]);

const ACRONYMS = new Set(["ai", "api", "crm", "csv", "faq", "kpi", "pdf", "pr", "roi", "seo", "sql", "ui", "url", "ux", "pnl", "sms"]);

/** Letters whose name starts with a vowel sound: "an SEO", "an FAQ". */
const VOWEL_SOUND_LETTERS = new Set("aefhilmnorsx".split(""));

function article(word: string): "a" | "an" {
  if (ACRONYMS.has(word)) return VOWEL_SOUND_LETTERS.has(word[0]!) ? "an" : "a";
  if (/^(uni|use|usu|eu|one|once)/.test(word)) return "a";
  if (/^(hour|honest|honou?r)/.test(word)) return "an";
  return /^[aeiou]/.test(word) ? "an" : "a";
}

/** "prs" is the plural of the acronym PR. */
function acronymPlural(word: string): boolean {
  return word.endsWith("s") && ACRONYMS.has(word.slice(0, -1));
}

function plural(word: string): boolean {
  return acronymPlural(word) || (word.length > 3 && word.endsWith("s") && !/(ss|us|is|ous)$/.test(word));
}

function display(word: string): string {
  if (ACRONYMS.has(word)) return word.toUpperCase();
  return acronymPlural(word) ? `${word.slice(0, -1).toUpperCase()}s` : word;
}

export function skillTitle(name: string): string {
  const words = name.toLowerCase().split(/[-_\s]+/).filter(Boolean);
  if (!words.length) return name;
  const out = words.map(display);
  const [verb, next] = words;
  const noun = words[words.length - 1]!;
  if (
    words.length >= 2 && VERBS.has(verb!) && next && !NO_ARTICLE_AFTER_VERB.has(next) &&
    !/^\d/.test(next) && !plural(noun) && !UNCOUNTABLE.has(noun) && !next.endsWith("ing")
  ) {
    out.splice(1, 0, article(next));
  }
  const sentence = out.join(" ");
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/** The description's first sentence, kept short enough for one card line. */
export function skillSubtitle(description: string, max = 140): string {
  const flat = description.replace(/\s+/g, " ").trim();
  const first = flat.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? flat;
  return first.length > max ? `${first.slice(0, max - 1).trimEnd()}…` : first;
}
