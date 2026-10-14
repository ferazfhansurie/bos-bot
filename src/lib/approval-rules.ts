import { useEffect, useSyncExternalStore } from "react";
import { api } from "@/state/store";
import {
  APPROVAL_RULE_OFFER_AT,
  approvalRuleKey,
  approvalRuleRisky,
  type ApprovalRule,
  type ApprovalRuleScope,
} from "../../shared/approval-rules";

// The client half of "approve these for me": the server's rule list, kept
// once per window, and which offers the person already turned down.

const DECLINED_KEY = "omb-approval-rule-declined";

let rules: ApprovalRule[] | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function changed() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function refreshApprovalRules(): Promise<void> {
  loading ??= api<{ rules?: ApprovalRule[] }>("/api/approval-rules")
    .then((body) => {
      rules = Array.isArray(body?.rules) ? body.rules : [];
    })
    .catch(() => {
      // A server without rules (or a peer session) simply makes no offers.
      rules ??= [];
    })
    .finally(() => {
      loading = null;
      changed();
    });
  return loading;
}

/** The person's rules; null until the first load. */
export function useApprovalRules(): ApprovalRule[] | null {
  const value = useSyncExternalStore(subscribe, () => rules, () => null);
  useEffect(() => {
    if (rules === null) void refreshApprovalRules();
  }, []);
  return value;
}

export async function createApprovalRule(input: { botId: string; threadId: string; key: string; scope: ApprovalRuleScope }): Promise<void> {
  const body = await api<{ rule?: ApprovalRule }>("/api/approval-rules", { method: "POST", body: JSON.stringify(input) });
  if (body?.rule) {
    rules = [...(rules ?? []).filter((rule) => rule.id !== body.rule!.id), body.rule];
    changed();
  }
}

export async function revokeApprovalRule(id: string): Promise<void> {
  await api(`/api/approval-rules/${id}`, { method: "DELETE" });
  rules = (rules ?? []).filter((rule) => rule.id !== id);
  changed();
}

function declinedSet(): Set<string> {
  try {
    const raw = localStorage.getItem(DECLINED_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

let declined: Set<string> | null = null;

export function offerDeclined(botId: string, key: string): boolean {
  declined ??= declinedSet();
  return declined.has(`${botId}\n${key}`);
}

/** "no" is remembered per bot and kind of action, so the offer does not come
 * back in the next thread either. */
export function declineOffer(botId: string, key: string): void {
  declined ??= declinedSet();
  declined.add(`${botId}\n${key}`);
  try {
    localStorage.setItem(DECLINED_KEY, JSON.stringify([...declined].slice(-500)));
  } catch {
    // still declined for this window
  }
  // A new list reference is what tells subscribed offers to re-render.
  rules = rules && [...rules];
  changed();
}

export interface ApprovalRuleOfferCandidate {
  key: string;
  tool: string;
  count: number;
}

interface CardMessage {
  from?: { botId: string };
  card?: { tool?: string; subtitle?: string; answered?: string; dismissed?: boolean; approvalScope?: string; requestId?: string };
}

/** The kind of action the person approved by hand often enough in this
 * thread to be offered a rule: the most recently approved one that counts
 * APPROVAL_RULE_OFFER_AT or more, is not risky, and is not already covered. */
export function approvalRuleOffer(
  messages: readonly CardMessage[],
  botId: string,
  threadId: string,
  existing: readonly ApprovalRule[],
): ApprovalRuleOfferCandidate | undefined {
  const counts = new Map<string, ApprovalRuleOfferCandidate>();
  let latest: string | undefined;
  for (const message of messages) {
    const card = message.card;
    if (!card?.requestId || !card.tool || card.answered !== "allow" || card.dismissed === true || card.approvalScope) continue;
    if ((message.from?.botId ?? botId) !== botId) continue;
    if (approvalRuleRisky({ tool: card.tool, summary: card.subtitle })) continue;
    const key = approvalRuleKey(card.tool, card.subtitle);
    if (!key) continue;
    const entry = counts.get(key) ?? { key, tool: card.tool, count: 0 };
    entry.count += 1;
    counts.set(key, entry);
    latest = key;
  }
  // Prefer what was just approved; fall back to any kind that qualifies.
  const ordered = [...counts.values()].sort((a, b) => (a.key === latest ? -1 : b.key === latest ? 1 : 0));
  return ordered.find((entry) =>
    entry.count >= APPROVAL_RULE_OFFER_AT &&
    !offerDeclined(botId, entry.key) &&
    !existing.some((rule) => rule.botId === botId && rule.key === entry.key && (!rule.threadId || rule.threadId === threadId))
  );
}
