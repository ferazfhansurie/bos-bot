// The live card's step line in plain words: what the bot is doing right now,
// from the tool it is running and its arguments. "reading retry.ts",
// "running tests", "searching the web". Lowercase, at most ~32 characters,
// never a path or a command line. The phone's ios/Sources/CompanionCore/
// LiveStep.swift says the same words when the app drives its own island.

export interface LiveStep {
  line: string;
  symbol: string;
  /** 1-based index of the plan step in progress, with the plan's size. */
  stepIndex?: number;
  stepCount?: number;
  /** The plan step in progress, as the bot wrote it (cleaned, ≤40). */
  planStep?: string;
}

interface ToolMessage { kind: string; at?: number; tool?: { name: string; ok?: boolean; summary?: string; input?: string }; comm?: unknown }

const LIMIT = 32;

const cap = (text: string, limit = LIMIT) => text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;

function parse(input: string | undefined): Record<string, unknown> | undefined {
  if (!input?.trim().startsWith("{")) return undefined;
  try {
    const value = JSON.parse(input);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

const str = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : undefined;

/** A path's last part, if it reads like a file name: "retry.ts". */
function fileName(fields: Record<string, unknown> | undefined): string | undefined {
  const raw = str(fields?.file_path) ?? str(fields?.path) ?? str(fields?.notebook_path) ?? str(fields?.filename);
  const base = raw?.split(/[\\/]/).filter(Boolean).at(-1);
  return base && base.length <= 24 && /^[\w.@+-]+$/.test(base) ? base : undefined;
}

function host(fields: Record<string, unknown> | undefined): string | undefined {
  try { return new URL(str(fields?.url) ?? "").hostname.replace(/^www\./, "") || undefined; } catch { return undefined; }
}

const COMMANDS: Array<[RegExp, string, string, number]> = [
  // pattern on one command segment, phrase, symbol, weight (highest wins)
  [/^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|vitest|jest)\b|^(?:npx\s+)?(?:vitest|jest|pytest|mocha)\b|^(?:swift|cargo|go)\s+test\b|^xcodebuild\b.*\btest\b/, "running tests", "checkmark.seal", 9],
  [/^git\s+(?:commit|push)\b/, "saving the work", "arrow.triangle.branch", 8],
  [/^(?:xcodebuild|swift\s+build|cargo\s+build|go\s+build|make\b|tsc\b)|^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build\b|\bbuild\.sh\b|\bios\.sh\b/, "building the app", "hammer", 8],
  [/^(?:npm|pnpm|yarn|bun)\s+(?:install|i|add)\b|^(?:pip3?|brew)\s+install\b/, "installing packages", "shippingbox", 7],
  [/^(?:xcrun\s+devicectl|devicectl)\b/, "installing on the phone", "iphone", 7],
  [/^(?:ssh|scp|rsync)\b/, "working on the server", "server.rack", 6],
  [/^(?:sudo\s+)?systemctl\b|^launchctl\b|^pm2\b/, "restarting a service", "arrow.clockwise", 6],
  [/^(?:curl|wget|http)\b/, "checking a website", "globe", 5],
  [/^(?:psql|sqlite3|mysql)\b/, "checking the database", "cylinder", 5],
  [/^(?:python3?|node|tsx|deno|bun|ruby)\b/, "running a script", "terminal", 4],
  [/^git\b/, "checking the code history", "arrow.triangle.branch", 3],
  [/^(?:rg|grep|ag|find|fd)\b/, "searching files", "magnifyingglass", 3],
  [/^(?:cat|head|tail|sed|less|wc|jq)\b/, "reading files", "doc.text", 2],
  [/^(?:ls|tree|pwd)\b/, "looking through files", "folder", 1],
];

/** A shell line as the thing it is for. Looks past `cd …`, env set-up and
 * wrappers, and when one line does several things says the one that matters
 * most: `cd x && pnpm test` is "running tests". */
export function commandStep(command: string): { line: string; symbol: string } {
  let best = { line: "running a command", symbol: "terminal", weight: 0 };
  for (const raw of command.split(/&&|\|\||;|\|/)) {
    const segment = raw.trim().replace(/^(?:\w+=\S*\s+)+/, "").replace(/^(?:sudo|time|env|nohup|exec)\s+/, "").trim();
    if (!segment || /^(?:cd|export|source|\.|set|echo|true|false)\b/.test(segment)) continue;
    for (const [pattern, line, symbol, weight] of COMMANDS) {
      if (pattern.test(segment) && weight > best.weight) best = { line, symbol, weight };
    }
  }
  return { line: best.line, symbol: best.symbol };
}

/** One tool call as a live step line. */
export function toolStep(rawName: string, summary?: string, input?: string): { line: string; symbol: string } {
  const name = rawName.trim();
  const lower = name.toLowerCase();
  const fields = parse(input);
  const file = fileName(fields);
  if (lower.startsWith("mcp__")) {
    const [, server = "", ...rest] = lower.split("__");
    const tool = rest.join("__");
    if (server === "computer" || server.includes("computer-use") || tool.startsWith("computer")) return { line: "using the computer", symbol: "desktopcomputer" };
    if (server.includes("browser") || tool.startsWith("agent_browser") || tool.startsWith("browser_")) {
      const site = host(fields);
      return { line: cap(site ? `on ${site}` : "using the browser"), symbol: "safari" };
    }
    if (server === "agents") {
      if (tool.includes("memory")) return { line: "updating its notes", symbol: "brain" };
      if (/coordinate|delegate|thread|room|bot/.test(tool)) return { line: "talking to the team", symbol: "person.2" };
      if (/search|session/.test(tool)) return { line: "checking its notes", symbol: "brain" };
      if (tool.includes("routine")) return { line: "checking its routines", symbol: "clock" };
      if (tool.includes("skill")) return { line: "updating a skill", symbol: "book" };
      return { line: "sorting things out", symbol: "gearshape" };
    }
    if (/whatsapp/.test(server + tool)) return { line: "on whatsapp", symbol: "message" };
    if (/postgres|neon|sql/.test(server)) return { line: "checking the database", symbol: "cylinder" };
    if (/gmail|mail/.test(server + tool)) return { line: "checking email", symbol: "envelope" };
    if (/calendar/.test(server + tool)) return { line: "checking the calendar", symbol: "calendar" };
    if (/slack/.test(server + tool)) return { line: "checking slack", symbol: "number" };
    if (/github/.test(server + tool)) return { line: "checking github", symbol: "arrow.triangle.branch" };
    if (/figma/.test(server)) return { line: "working in figma", symbol: "paintbrush" };
    if (/pipeboard|meta|ads/.test(server)) return { line: "checking the ads", symbol: "megaphone" };
    const label = server.replace(/[_-]+/g, " ").trim();
    return { line: cap(label ? `using ${label}` : "using a tool"), symbol: "gearshape" };
  }
  switch (lower) {
    case "read": case "view": case "notebookread": case "read_file":
      return { line: cap(file ? `reading ${file}` : "reading a file"), symbol: "doc.text" };
    case "write": case "create": case "write_file": case "create_file":
      return { line: cap(file ? `writing ${file}` : "writing a file"), symbol: "square.and.pencil" };
    case "edit": case "multiedit": case "notebookedit": case "str_replace": case "apply_patch": case "patch":
      return { line: cap(file ? `editing ${file}` : "editing a file"), symbol: "pencil" };
    case "bash": case "shell": case "terminal": case "run": case "exec": case "exec_command": case "local_shell": case "run_command": case "execute":
      return commandStep(str(fields?.command) ?? summary ?? "");
    case "bashoutput": case "monitor": case "write_stdin":
      return { line: "checking on a command", symbol: "terminal" };
    case "grep": case "glob": case "search": case "codebase_search": case "ls": case "list_dir": case "find":
      return { line: "searching files", symbol: "magnifyingglass" };
    case "toolsearch":
      return { line: "looking up its tools", symbol: "wrench.and.screwdriver" };
    case "websearch": case "web_search": case "web_search_call":
      return { line: "searching the web", symbol: "globe" };
    case "webfetch": case "fetch": case "web_fetch": {
      const site = host(fields);
      return { line: cap(site ? `reading ${site}` : "reading a web page"), symbol: "globe" };
    }
    case "task": case "agent": case "dispatch_agent": case "spawn_agent": case "workflow":
      return { line: "got a helper on it", symbol: "person.2" };
    case "todowrite": case "update_plan": case "exitplanmode": case "enterplanmode":
      return { line: "making a plan", symbol: "list.bullet" };
    case "skill":
      return { line: "following a skill", symbol: "book" };
    case "askuserquestion":
      return { line: "asking you something", symbol: "questionmark.bubble" };
    case "image_gen": case "imagegen": case "generate_image":
      return { line: "making an image", symbol: "photo" };
    default:
      if (/computer|screenshot|^click$|^type_text$/.test(lower)) return { line: "using the computer", symbol: "desktopcomputer" };
      if (lower.includes("browser")) return { line: "using the browser", symbol: "safari" };
      if (lower.includes("search")) return { line: "searching", symbol: "magnifyingglass" };
      return { line: "working on it", symbol: "gearshape" };
  }
}

/** The plan's state, from the newest TodoWrite (claude) or update_plan
 * (codex) in the tail. */
export function planProgress(messages: readonly ToolMessage[]): Pick<LiveStep, "stepIndex" | "stepCount" | "planStep"> {
  const plan = [...messages].reverse().find(message => message.kind === "activity" && /^(todowrite|update_plan)$/i.test(message.tool?.name ?? ""));
  const fields = parse(plan?.tool?.input);
  const items = Array.isArray(fields?.todos) ? fields.todos : Array.isArray(fields?.plan) ? fields.plan : undefined;
  if (!items?.length) return {};
  const steps = items.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object").slice(0, 40);
  if (steps.length < 2) return {};
  const status = (item: Record<string, unknown>) => String(item.status ?? "").toLowerCase();
  let at = steps.findIndex(item => status(item) === "in_progress");
  if (at < 0) at = steps.findIndex(item => status(item) !== "completed");
  if (at < 0) return { stepIndex: steps.length, stepCount: steps.length };
  const text = str(steps[at].activeForm) ?? str(steps[at].content) ?? str(steps[at].step);
  const planStep = text ? cap(text.replace(/\S*[\\/]\S*/g, word => word.split(/[\\/]/).filter(Boolean).at(-1) ?? "").replace(/`/g, "").replace(/\s+/g, " ").trim().toLowerCase(), 40) : undefined;
  return { stepIndex: at + 1, stepCount: steps.length, ...(planStep ? { planStep } : {}) };
}

/** What the bot is doing now, from a thread's tail: the newest tool step
 * that is not a chat notice, plus the plan. Undefined before any tool ran,
 * so the caller keeps the last real step instead of a bare "thinking". */
export function liveStep(all: readonly ToolMessage[], since = 0): LiveStep | undefined {
  // only this job's steps: an older turn's tool is not what it is doing now
  const messages = all.filter(message => (message.at ?? Infinity) >= since - 1_000);
  const last = [...messages].reverse().find(message => message.kind === "activity" && message.tool?.name && !message.comm
    && !/^(auto-approved|error|completion|blocker|correction):/i.test(message.tool.name));
  const plan = planProgress(messages);
  if (!last?.tool) return plan.stepCount ? { line: "working on it", symbol: "gearshape", ...plan } : undefined;
  return { ...toolStep(last.tool.name, last.tool.summary, last.tool.input), ...plan };
}
