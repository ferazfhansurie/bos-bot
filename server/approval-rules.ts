// The person's own "approve these for me" rules, persisted beside the other
// app state. Matching is deliberately narrow: same bot, same thread for a
// thread rule, same kind of action, and never a risky request (see
// shared/approval-rules.ts). Deleting the file forgets every rule.
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { approvalRuleKey, approvalRuleRisky, type ApprovalRule, type ApprovalRuleRequest } from "../shared/approval-rules.ts";
import { writeFileAtomic } from "./atomic.ts";

const FILE_NAME = "approval-rules.json";
const MAX_RULES = 500;

function valid(raw: unknown): raw is ApprovalRule {
  if (!raw || typeof raw !== "object") return false;
  const rule = raw as Record<string, unknown>;
  return typeof rule.id === "string" && typeof rule.botId === "string" && typeof rule.key === "string"
    && typeof rule.tool === "string" && typeof rule.createdAt === "number"
    && (rule.threadId === undefined || typeof rule.threadId === "string");
}

export function createApprovalRules(dataDir: string) {
  const file = join(dataDir, FILE_NAME);
  let rules: ApprovalRule[] = [];
  try {
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      if (Array.isArray(parsed)) rules = parsed.filter(valid);
    }
  } catch {
    // A corrupt file means no rules: every card asks again, the safe side.
    rules = [];
  }
  const save = () => writeFileAtomic(file, JSON.stringify(rules, null, 2), { mode: 0o600 });

  return {
    list(): ApprovalRule[] {
      return rules.map((rule) => ({ ...rule }));
    },
    /** Whether any rule could answer for this bot in this thread. */
    has(botId: string, threadId: string): boolean {
      return rules.some((rule) => rule.botId === botId && (!rule.threadId || rule.threadId === threadId));
    },
    /** The rule that answers this request, or undefined when it must ask. */
    match(botId: string, threadId: string, request: ApprovalRuleRequest): ApprovalRule | undefined {
      if (approvalRuleRisky(request)) return undefined;
      const key = approvalRuleKey(request.tool, request.summary);
      if (!key) return undefined;
      return rules.find((rule) => rule.botId === botId && rule.key === key && (!rule.threadId || rule.threadId === threadId));
    },
    add(input: { botId: string; threadId?: string; key: string; tool: string }): ApprovalRule {
      const existing = rules.find((rule) => rule.botId === input.botId && rule.key === input.key && rule.threadId === input.threadId);
      if (existing) return { ...existing };
      const rule: ApprovalRule = { id: randomUUID(), createdAt: Date.now(), ...input };
      rules = [...rules, rule].slice(-MAX_RULES);
      save();
      return { ...rule };
    },
    remove(id: string): boolean {
      const next = rules.filter((rule) => rule.id !== id);
      if (next.length === rules.length) return false;
      rules = next;
      save();
      return true;
    },
  };
}

export type ApprovalRules = ReturnType<typeof createApprovalRules>;
