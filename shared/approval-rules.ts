// Approval rules: "approve these for me" after the person has answered the
// same kind of action by hand a few times. The server matches rules when a
// permission card would otherwise be shown; the client counts approvals and
// makes the offer. Both use this file so they agree on what "the same kind of
// action" is and on what may never be answered for the person.
//
// A rule is a convenience over a card the person already answered three
// times, not a grant of trust. Anything that deletes, sends something out,
// moves money, controls this computer, widens a sandbox, or that this file
// cannot read in full still asks every time, whatever rules exist.

/** Manual approvals of one kind in one thread before the offer appears. */
export const APPROVAL_RULE_OFFER_AT = 3;

export type ApprovalRuleScope = "thread" | "bot";

export interface ApprovalRule {
  id: string;
  botId: string;
  /** Present for a one-thread rule; absent means every thread of the bot. */
  threadId?: string;
  /** What the rule matches: see approvalRuleKey. */
  key: string;
  /** The tool as the card showed it, for the settings list. */
  tool: string;
  createdAt: number;
}

export interface ApprovalRuleRequest {
  tool: string;
  summary?: string;
  approvalScope?: string;
  requiresExplicitApproval?: boolean;
}

const SHELL_TOOLS = new Set(["bash", "shell", "exec_command", "run_shell_command", "run_terminal_cmd", "terminal", "execute", "powershell"]);
const EDIT_TOOLS = new Set(["edit", "write", "multiedit", "notebookedit", "apply_patch", "write_file", "edit_file", "replace", "str_replace_editor"]);

/** The tool name without an MCP server prefix, lower-cased. */
function baseTool(tool: string): string {
  return tool.replace(/^mcp__[^_]+__/, "").toLowerCase();
}

function isShell(tool: string): boolean {
  return SHELL_TOOLS.has(baseTool(tool));
}

function isEdit(tool: string): boolean {
  return EDIT_TOOLS.has(baseTool(tool));
}

/** The command a shell summary runs first, without env assignments. */
function shellProgram(summary: string): string | undefined {
  const words = summary.trim().split(/\s+/).filter((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
  const first = words[0]?.replace(/^.*\//, "");
  return first && /^[\w.+-]+$/.test(first) ? first.toLowerCase() : undefined;
}

// Verbs that delete, send out, publish, or move money. Matched as words in a
// tool name or in what the card says it will do.
const RISKY_WORDS =
  /(^|[^a-z])(rm|rmdir|unlink|del|delete|deletes|deleted|deleting|remove|removes|erase|destroy|drop|truncate|purge|wipe|shred|kill|killall|pkill|shutdown|reboot|format|mkfs|dd|send|sends|sending|sendmail|mail|email|e-mail|message|messages|sms|dm|reply|tweet|post|posts|posting|publish|publishes|deploy|release|push|share|invite|upload|pay|pays|payment|payments|charge|charges|refund|refunds|transfer|transfers|invoice|invoices|purchase|purchases|buy|checkout|order|subscribe|withdraw|sudo|su|chmod|chown|curl|wget|ssh|scp|rsync|osascript|eval|exec)([^a-z]|$)/i;
// Shell syntax that runs more than the first program, or writes elsewhere.
const SHELL_CHAINING = /[;&|`<>]|\$\(|\n/;
// Card summaries are cut at 200 characters, so a summary that long may hide
// the rest of the command. Ask rather than guess what the tail does.
const SUMMARY_LIMIT = 199;

/** Whether this request must reach the person whatever rules exist. */
export function approvalRuleRisky(request: ApprovalRuleRequest): boolean {
  const tool = request.tool ?? "";
  const summary = request.summary ?? "";
  if (!tool) return true;
  if (request.approvalScope === "local-computer" || request.requiresExplicitApproval) return true;
  if (tool.startsWith('mcp__computer__') || /computer|browser|workbench|remote_bash|multi_execute/i.test(tool)) return true;
  if (/^(askuserquestion|ask_user)$/.test(baseTool(tool))) return true;
  if (RISKY_WORDS.test(baseTool(tool).replace(/[_-]+/g, " "))) return true;
  if (isShell(tool)) {
    const program = shellProgram(summary);
    if (!program || summary.length >= SUMMARY_LIMIT || SHELL_CHAINING.test(summary)) return true;
    // An interpreter handed inline code can do anything the code says.
    if (/^(python[\d.]*|node|bun|deno|ruby|perl|php|bash|sh|zsh|fish|pwsh|powershell)$/.test(program) && /\s(-c|-e|--eval|-r|-p)\b/.test(summary)) return true;
    // git is fine for status and diffs; anything that rewrites or pushes asks.
    if (program === "git" && /\b(push|reset|clean|checkout\s+--|restore|rebase|branch\s+-[dD]|tag\s+-d|filter-branch|gc|prune)\b|--force|\s-f\b/.test(summary)) return true;
    return RISKY_WORDS.test(summary);
  }
  // A file edit's summary is the file's own contents: words in it describe
  // the code, not what the edit does.
  if (isEdit(tool)) return false;
  return summary.length >= SUMMARY_LIMIT || RISKY_WORDS.test(summary);
}

/** What makes two requests "the same kind of action": the tool, and for a
 * shell the program it runs (approving `git status` three times offers git,
 * never every command). Undefined when the request has no stable kind. */
export function approvalRuleKey(tool: string | undefined, summary?: string): string | undefined {
  if (!tool) return undefined;
  if (isShell(tool)) {
    const program = shellProgram(summary ?? "");
    return program ? `${tool}:${program}` : undefined;
  }
  return tool;
}

/** How the settings list names a rule: "git (Bash)" or the tool itself. */
export function approvalRuleLabel(rule: Pick<ApprovalRule, "key" | "tool">): string {
  const program = rule.key.startsWith(`${rule.tool}:`) ? rule.key.slice(rule.tool.length + 1) : "";
  return program ? `${program} (${rule.tool})` : rule.tool;
}
