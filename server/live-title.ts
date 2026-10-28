// The live card's title: what the job is, in at most five words. A thread's
// own name wins when it is already short and not just the first message cut
// off; otherwise one cheap one-shot per job names it, and until (or unless)
// that answers, the card shows the job's message, cleaned and cut short.
// Never one model call per update: a job is asked about once.
import { titleFromLlm } from "./store.ts";

const WORDS = 5;
const CHARS = 32;

/** The start of a message as a person would name it: the harness and voice
 * preambles dropped, the first sentence, at most five words. */
export function fallbackTitle(text: string): string | undefined {
  let body = text.replace(/\r/g, "").trim();
  // "[Thread you opened yourself from #voice · …]" style preambles
  while (/^\[[^\]\n]{0,400}\]\s*/.test(body)) body = body.replace(/^\[[^\]\n]{0,400}\]\s*/, "");
  body = body.replace(/^sent from a live voice call:[^.\n]*(?:\.[^.\n]*){0,1}\.\s*/i, "");
  const line = body.split("\n").map(part => part.trim()).find(Boolean) ?? "";
  const sentence = line.split(/(?<=[.?!])\s/)[0] ?? line;
  const words = sentence.replace(/[`*_#>]+/g, "").replace(/https?:\/\/\S+/g, "").replace(/\S*[\\/]\S*/g, "").split(/\s+/).filter(Boolean);
  if (!words.length) return undefined;
  let title = words.slice(0, WORDS).join(" ").replace(/[,:;.!?]+$/, "");
  if (title.length > CHARS) title = `${title.slice(0, CHARS - 1).trimEnd()}…`;
  else if (words.length > WORDS) title = `${title}…`;
  return title.toLowerCase();
}

/** A stored thread name short enough for the card, and not a first-message
 * snippet (those end in an ellipsis or run long). */
export function usableThreadTitle(title: string | undefined): string | undefined {
  const clean = title?.trim();
  if (!clean || clean.endsWith("…") || clean.length > CHARS) return undefined;
  if (clean.split(/\s+/).length > WORDS + 1) return undefined;
  return clean;
}

/** A short title reply from the model, or undefined if it is not one. */
export function shortTitle(raw: string): string | undefined {
  const line = titleFromLlm(raw);
  if (!line) return undefined;
  const words = line.split(/\s+/);
  if (words.length > WORDS + 1) return undefined;
  return (line.length > CHARS ? `${line.slice(0, CHARS - 1).trimEnd()}…` : line).toLowerCase();
}

export interface LiveTitleDeps {
  /** The thread's stored name, if any. */
  threadTitle: (botId: string, threadId: string) => string | undefined;
  /** The message that started the job (the newest owner message at or
   * before `since`, else the newest one). */
  jobMessage: (threadId: string, since: number) => string | undefined;
  /** The bot's cheap one-shot, if its engine has one. */
  generate: (botId: string) => ((prompt: string, options?: { signal?: AbortSignal }) => Promise<string>) | undefined;
  /** A generated title just arrived: redraw the card. */
  ready: () => void;
}

export class LiveTitles {
  /** `${threadId}:${since}` → the title (undefined while asking). */
  private made = new Map<string, string | undefined>();
  private readonly deps: LiveTitleDeps;
  constructor(deps: LiveTitleDeps) { this.deps = deps; }

  title(botId: string, threadId: string, since: number): string | undefined {
    const stored = usableThreadTitle(this.deps.threadTitle(botId, threadId));
    if (stored) return stored.toLowerCase();
    const key = `${threadId}:${Math.round(since)}`;
    if (this.made.has(key)) return this.made.get(key) ?? this.fallback(threadId, since);
    const message = this.deps.jobMessage(threadId, since);
    const generate = message?.trim() ? this.deps.generate(botId) : undefined;
    this.made.set(key, undefined);
    // keep the cache to recent jobs
    if (this.made.size > 200) this.made.delete(this.made.keys().next().value!);
    if (generate && message) void this.ask(generate, message, key);
    return this.fallback(threadId, since);
  }

  private fallback(threadId: string, since: number): string | undefined {
    const message = this.deps.jobMessage(threadId, since);
    return message ? fallbackTitle(message) : undefined;
  }

  private async ask(generate: NonNullable<ReturnType<LiveTitleDeps["generate"]>>, message: string, key: string): Promise<void> {
    const prompt = [
      "Name the job asked for in the message below, for a phone's lock screen.",
      "Reply with only the name: 2 to 5 words, lowercase, plain text, no quotes, no trailing period.",
      "Message:",
      message.trim().slice(0, 1_500),
    ].join("\n");
    const expiry = new AbortController();
    const timer = setTimeout(() => expiry.abort(), 10_000);
    try {
      const title = shortTitle(await generate(prompt, { signal: expiry.signal }));
      if (title && this.made.has(key)) { this.made.set(key, title); this.deps.ready(); }
    } catch { /* the cleaned message stays */ } finally { clearTimeout(timer); }
  }
}
