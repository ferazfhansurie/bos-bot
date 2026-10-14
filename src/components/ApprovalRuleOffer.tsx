import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import { t } from "@/lib/i18n";
import { approvalRuleOffer, createApprovalRule, declineOffer, useApprovalRules } from "@/lib/approval-rules";
import { approvalRuleLabel, type ApprovalRuleScope } from "../../shared/approval-rules";
import { useStore, type Message } from "@/state/store";

const BUTTON =
  "flex h-7 shrink-0 items-center rounded-full px-2.5 text-[12.5px] font-medium outline-none hover:bg-raised-hover focus-visible:ring-2 focus-visible:ring-accent/60 disabled:opacity-60";

/** After the person approves the same kind of action by hand a few times in
 * one thread, offer to stop asking: for this thread, for every thread of
 * this bot, or not at all. Risky actions are never offered (and never
 * matched on the server, whatever rule exists). */
export function ApprovalRuleOffer({ botId, threadId, messages }: { botId: string; threadId: string; messages: readonly Message[] }) {
  const { dispatch } = useStore();
  const rules = useApprovalRules();
  const [saving, setSaving] = useState(false);
  if (!rules) return null;
  const offer = approvalRuleOffer(messages, botId, threadId, rules);
  if (!offer) return null;
  const label = approvalRuleLabel(offer);
  const accept = (scope: ApprovalRuleScope) => {
    setSaving(true);
    createApprovalRule({ botId, threadId, key: offer.key, scope })
      .catch((error) => {
        dispatch({ type: "error", message: error instanceof Error ? error.message : String(error) });
        window.setTimeout(() => dispatch({ type: "error", message: null }), 6000);
      })
      .finally(() => setSaving(false));
  };
  return (
    <div className="px-5 pb-2">
      <section
        aria-label={t("approvalRules.title")}
        className="animate-pop-in mx-auto flex w-full max-w-[560px] items-center gap-1 overflow-hidden rounded-[18px] border border-hairline/25 bg-raised/70 py-1 pe-1 ps-3 text-ink backdrop-blur-md"
      >
        <ShieldCheck size={13} aria-hidden="true" className="shrink-0 text-ink-secondary" />
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-secondary" title={label}>
          {t("approvalRules.offer", { tool: label, count: offer.count })}
        </span>
        <button type="button" disabled={saving} onClick={() => accept("thread")} className={`${BUTTON} text-ink`}>
          {t("approvalRules.thread")}
        </button>
        <button type="button" disabled={saving} onClick={() => accept("bot")} className={`${BUTTON} text-ink`}>
          {t("approvalRules.always")}
        </button>
        <button type="button" disabled={saving} onClick={() => declineOffer(botId, offer.key)} className={`${BUTTON} text-ink-secondary hover:text-ink`}>
          {t("approvalRules.no")}
        </button>
      </section>
    </div>
  );
}
